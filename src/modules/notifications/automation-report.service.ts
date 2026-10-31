import {
  AutomationEvent,
  MemberBonoStatus,
  NotificationStatus,
  NotificationType,
  PrismaClient,
  WalletSyncStatus
} from "@prisma/client";

/**
 * Read-only reporting on the automated wallet notifications (birthday + bono reminder),
 * the same picture `npm run notify:report` prints, served to the admin panel.
 * SELECT-only: nothing here writes, and callers are Voone staff endpoints.
 */

import { AUTOMATION_NOTIFICATION_TYPES } from "./automations/catalog";
import { resolveAutomations } from "./automations/automation-settings.service";

const AUTOMATION_TYPES = [...AUTOMATION_NOTIFICATION_TYPES];
const DAYS_TO_SCAN = 7;
const NOTIFICATION_LOOKBACK_DAYS = 90;
const NOTIFICATION_LIMIT = 30;
const BONO_NAME_LIMIT = 25;
/** A PARTIAL_FAILED send still reached some members, so it counts as sent. */
const SENT_STATUSES = [NotificationStatus.SENT, NotificationStatus.PARTIAL_FAILED];

/** What the report selects for a clinic's settings; shared by both queries. */
const SETTINGS_SELECT = {
  notificationSettings: { select: { marketingEnabled: true } },
  automations: { select: { event: true, enabled: true, header: true, body: true, notify: true } }
} as const;

export interface AutomationClinicSettings {
  marketingEnabled: boolean;
  birthdayEnabled: boolean;
  birthdayNotify: boolean;
  /** The day the newest birthday send was created, "YYYY-MM-DD" (UTC), or null. */
  birthdayLastRunDate: string | null;
  bonoReminderEnabled: boolean;
  bonoReminderNotify: boolean;
  /** Every automated event, so the admin panel needs no change per new event. */
  automations: Record<AutomationEvent, { enabled: boolean; notify: boolean }>;
  usesDefaults: boolean;
}

export interface ManualNotificationQuota {
  monthlyQuota: number;
  usedThisMonth: number;
  remainingThisMonth: number;
}

export interface ClinicAutomationOverviewItem {
  clinicId: string;
  name: string;
  addressLine: string;
  isActive: boolean;
  settings: AutomationClinicSettings;
  manualQuota: ManualNotificationQuota;
  totalNotificationsSent: number;
  upcomingBirthdayCandidates: number;
  bonoCandidates: number;
  recentBirthdayNotifications: number;
  recentBonoNotifications: number;
  lastAutomationSentAt: string | null;
}

export interface AutomationOverview {
  clinics: ClinicAutomationOverviewItem[];
}

export interface DeliveryBreakdownEntry {
  status: string;
  errorCode: string | null;
  provider: string;
  count: number;
}

export interface NotificationDeliveryDetail {
  memberId: string;
  memberName: string;
  provider: string;
  status: string;
  errorCode: string | null;
}

export interface AutomationNotificationDetail {
  id: string;
  type: string;
  status: string;
  notify: boolean;
  header: string;
  createdAt: string;
  deliveriesTotal: number;
  breakdown: DeliveryBreakdownEntry[];
  deliveries: NotificationDeliveryDetail[];
}

export interface BirthdayCandidate {
  memberId: string;
  name: string;
  birthday: string;
  willSend: boolean;
  skipReasons: string[];
}

export interface BonoCandidateSummary {
  eligible: number;
  skipped: number;
  eligibleNames: string[];
  nextSendDate: string;
}

export interface NotificationTypeTotal {
  type: string;
  count: number;
}

export interface NotificationTotals {
  sentAllTime: number;
  byType: NotificationTypeTotal[];
}

export interface ClinicAutomationReport {
  clinicId: string;
  name: string;
  isActive: boolean;
  settings: AutomationClinicSettings;
  manualQuota: ManualNotificationQuota;
  totals: NotificationTotals;
  notifications: AutomationNotificationDetail[];
  birthdayCandidates: BirthdayCandidate[];
  bono: BonoCandidateSummary;
}

const monthDay = (date: Date): string =>
  `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const latestOf = (
  notifications: ReadonlyArray<{ type: NotificationType; createdAt: Date }>,
  type: NotificationType
): Date | null =>
  notifications
    .filter((notification) => notification.type === type)
    .reduce<Date | null>(
      (latest, notification) =>
        latest && latest > notification.createdAt ? latest : notification.createdAt,
      null
    );

const birthdayWindow = (days: number): Set<string> => {
  const window = new Set<string>();

  for (let offset = 0; offset < days; offset += 1) {
    window.add(monthDay(new Date(Date.now() + offset * 24 * 60 * 60 * 1_000)));
  }

  return window;
};

export class AutomationReportService {
  constructor(private readonly prisma: PrismaClient) {}

  async automationOverview(): Promise<AutomationOverview> {
    const clinics = await this.prisma.clinic.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        addressLine: true,
        notificationsMonthlyQuota: true,
        notificationsUsedThisMonth: true,
        ...SETTINGS_SELECT
      },
      orderBy: { createdAt: "asc" }
    });

    const since = new Date(Date.now() - NOTIFICATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000);
    const recent = await this.prisma.notification.findMany({
      where: { type: { in: AUTOMATION_TYPES }, createdAt: { gte: since } },
      select: { clinicId: true, type: true, createdAt: true }
    });
    const sentAllTime = await this.prisma.notification.groupBy({
      by: ["clinicId"],
      where: { status: { in: SENT_STATUSES } },
      _count: { _all: true }
    });
    const sentByClinic = new Map(
      sentAllTime.map((row) => [row.clinicId, row._count._all] as const)
    );

    const items: ClinicAutomationOverviewItem[] = [];
    for (const clinic of clinics) {
      const [birthdayCount, bonoCount] = await Promise.all([
        this.countBirthdayCandidates(clinic.id),
        this.countBonoCandidates(clinic.id)
      ]);
      const clinicRecent = recent.filter((n) => n.clinicId === clinic.id);
      const lastSent = clinicRecent
        .map((n) => n.createdAt.getTime())
        .sort((left, right) => right - left)[0];

      items.push({
        clinicId: clinic.id,
        name: clinic.name,
        addressLine: clinic.addressLine,
        isActive: true,
        settings: this.effectiveSettings(clinic, latestOf(clinicRecent, NotificationType.BIRTHDAY)),
        manualQuota: this.manualQuota(
          clinic.notificationsMonthlyQuota,
          clinic.notificationsUsedThisMonth
        ),
        totalNotificationsSent: sentByClinic.get(clinic.id) ?? 0,
        upcomingBirthdayCandidates: birthdayCount,
        bonoCandidates: bonoCount,
        recentBirthdayNotifications: clinicRecent.filter(
          (n) => n.type === NotificationType.BIRTHDAY
        ).length,
        recentBonoNotifications: clinicRecent.filter(
          (n) => n.type === NotificationType.BONO_REMINDER
        ).length,
        lastAutomationSentAt: lastSent ? new Date(lastSent).toISOString() : null
      });
    }

    return { clinics: items };
  }

  async clinicAutomationReport(clinicId: string): Promise<ClinicAutomationReport | null> {
    const clinic = await this.prisma.clinic.findFirst({
      where: { id: clinicId },
      select: {
        id: true,
        name: true,
        isActive: true,
        notificationsMonthlyQuota: true,
        notificationsUsedThisMonth: true,
        ...SETTINGS_SELECT
      }
    });

    if (!clinic) return null;

    const since = new Date(Date.now() - NOTIFICATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000);
    const notifications = await this.prisma.notification.findMany({
      where: { clinicId: clinic.id, type: { in: AUTOMATION_TYPES }, createdAt: { gte: since } },
      select: { id: true, type: true, status: true, notify: true, header: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: NOTIFICATION_LIMIT
    });
    const deliveries = await this.prisma.notificationDelivery.findMany({
      where: { notificationId: { in: notifications.map((n) => n.id) } },
      select: {
        notificationId: true,
        memberId: true,
        member: { select: { name: true } },
        status: true,
        errorCode: true,
        provider: true
      }
    });

    const notificationDetails: AutomationNotificationDetail[] = notifications.map((n) => {
      const mine = deliveries.filter((d) => d.notificationId === n.id);
      const grouped = new Map<string, DeliveryBreakdownEntry>();
      for (const d of mine) {
        const key = `${d.status}|${d.errorCode ?? ""}|${d.provider}`;
        const entry = grouped.get(key) ?? {
          status: d.status,
          errorCode: d.errorCode,
          provider: d.provider,
          count: 0
        };
        entry.count += 1;
        grouped.set(key, entry);
      }

      return {
        id: n.id,
        type: n.type,
        status: n.status,
        notify: n.notify,
        header: n.header,
        createdAt: n.createdAt.toISOString(),
        deliveriesTotal: mine.length,
        breakdown: [...grouped.values()].sort(
          (left, right) => right.count - left.count || left.status.localeCompare(right.status)
        ),
        deliveries: mine
          .map((d) => ({
            memberId: d.memberId,
            memberName: d.member.name,
            provider: d.provider,
            status: d.status,
            errorCode: d.errorCode
          }))
          .sort(
            (left, right) =>
              left.memberName.localeCompare(right.memberName) ||
              left.status.localeCompare(right.status)
          )
      };
    });

    return {
      clinicId: clinic.id,
      name: clinic.name,
      isActive: clinic.isActive,
      settings: this.effectiveSettings(clinic, latestOf(notifications, NotificationType.BIRTHDAY)),
      manualQuota: this.manualQuota(
        clinic.notificationsMonthlyQuota,
        clinic.notificationsUsedThisMonth
      ),
      totals: await this.notificationTotals(clinic.id),
      notifications: notificationDetails,
      birthdayCandidates: await this.birthdayCandidates(clinic.id),
      bono: await this.bonoCandidates(clinic.id)
    };
  }

  private manualQuota(monthlyQuota: number, usedThisMonth: number): ManualNotificationQuota {
    return {
      monthlyQuota,
      usedThisMonth,
      remainingThisMonth: Math.max(0, monthlyQuota - usedThisMonth)
    };
  }

  private async notificationTotals(clinicId: string): Promise<NotificationTotals> {
    const byType = await this.prisma.notification.groupBy({
      by: ["type"],
      where: { clinicId, status: { in: SENT_STATUSES } },
      _count: { _all: true }
    });

    return {
      sentAllTime: byType.reduce((total, row) => total + row._count._all, 0),
      byType: byType
        .map((row) => ({ type: row.type, count: row._count._all }))
        .sort((left, right) => right.count - left.count)
    };
  }

  private effectiveSettings(
    clinic: {
      notificationSettings: { marketingEnabled: boolean } | null;
      automations: Array<{
        event: AutomationEvent;
        enabled: boolean;
        header: string;
        body: string;
        notify: boolean;
      }>;
    },
    lastBirthdayAt: Date | null
  ): AutomationClinicSettings {
    const resolved = resolveAutomations(clinic.automations);
    const automations = Object.fromEntries(
      Object.entries(resolved).map(([event, value]) => [
        event,
        { enabled: value.enabled, notify: value.notify }
      ])
    ) as AutomationClinicSettings["automations"];

    return {
      marketingEnabled: clinic.notificationSettings?.marketingEnabled ?? true,
      birthdayEnabled: resolved.BIRTHDAY.enabled,
      birthdayNotify: resolved.BIRTHDAY.notify,
      birthdayLastRunDate: lastBirthdayAt ? lastBirthdayAt.toISOString().slice(0, 10) : null,
      bonoReminderEnabled: resolved.BONO_INACTIVE.enabled,
      bonoReminderNotify: resolved.BONO_INACTIVE.notify,
      automations,
      usesDefaults: clinic.notificationSettings === null && clinic.automations.length === 0
    };
  }

  private async countBirthdayCandidates(clinicId: string): Promise<number> {
    const members = await this.birthdayMembers(clinicId);

    return members.filter((member) => member.willSend).length;
  }

  private async birthdayCandidates(clinicId: string): Promise<BirthdayCandidate[]> {
    return this.birthdayMembers(clinicId);
  }

  private async birthdayMembers(clinicId: string): Promise<BirthdayCandidate[]> {
    const window = birthdayWindow(DAYS_TO_SCAN);
    const members = await this.prisma.member.findMany({
      where: { clinicId, erasedAt: null, birthDate: { not: null } },
      select: {
        id: true,
        name: true,
        consentMarketing: true,
        birthDate: true,
        walletObjects: { select: { status: true } }
      },
      orderBy: { name: "asc" }
    });

    return members
      .filter((member) => member.birthDate && window.has(monthDay(member.birthDate)))
      .map((member) => {
        const skipReasons: string[] = [];
        if (!member.consentMarketing) skipReasons.push("no_consent");
        if (
          !member.walletObjects.some(
            (walletObject) => walletObject.status === WalletSyncStatus.SYNCED
          )
        ) {
          skipReasons.push("no_synced_pass");
        }

        return {
          memberId: member.id,
          name: member.name,
          birthday: member.birthDate ? monthDay(member.birthDate) : "",
          willSend: skipReasons.length === 0,
          skipReasons
        };
      });
  }

  private async countBonoCandidates(clinicId: string): Promise<number> {
    const summary = await this.bonoCandidates(clinicId);

    return summary.eligible;
  }

  private async bonoCandidates(clinicId: string): Promise<BonoCandidateSummary> {
    const members = await this.prisma.member.findMany({
      where: { clinicId, erasedAt: null, bonos: { some: { status: MemberBonoStatus.ACTIVE } } },
      select: { name: true, walletObjects: { select: { status: true } } },
      orderBy: { name: "asc" }
    });
    const eligible = members.filter((member) =>
      member.walletObjects.some((walletObject) => walletObject.status === WalletSyncStatus.SYNCED)
    );

    // The reminder rides the daily cron but only acts on the 1st of the month.
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    return {
      eligible: eligible.length,
      skipped: members.length - eligible.length,
      eligibleNames: eligible.slice(0, BONO_NAME_LIMIT).map((member) => member.name),
      nextSendDate: next.toISOString()
    };
  }
}
