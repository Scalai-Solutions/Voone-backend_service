import {
  ClinicNotifyOnCredit,
  MemberBonoStatus,
  NotificationDeliveryStatus,
  NotificationStatus,
  NotificationType,
  Prisma,
  WalletProviderType,
  WalletSyncStatus,
  type PrismaClient
} from "@prisma/client";

import { config } from "../../config/env";
import {
  WalletNotificationNotFoundError,
  WalletNotificationQuotaExceededError,
  WalletNotificationTransientError
} from "../../common/errors/wallet.errors";
import type { WalletPassEngine } from "../../wallet/engine/wallet-pass.engine";
import { hasPermission, PERMISSIONS } from "../auth/rbac";
import { displayPoints } from "../onboarding/runtime/points-unit";
import {
  NotificationForbiddenError,
  NotificationNotFoundError,
  NotificationRateLimitError
} from "./notification.errors";
import type {
  ClinicLocationInput,
  NotificationMessageInput,
  NotificationSegmentInput,
  NotificationSettingsInput,
  SegmentNotificationInput
} from "./notifications.schema";
import { NotificationQuotaService } from "./quota.service";

const BROADCAST_LIMIT = 3;
const BROADCAST_WINDOW_MS = 24 * 60 * 60 * 1_000;
const PAGE_SIZE = 25;
const MANUAL_NOTIFICATION_TYPES = new Set<NotificationType>([
  NotificationType.BROADCAST,
  NotificationType.SEGMENT,
  NotificationType.SINGLE
]);
const birthdayDay = (
  date: Date,
  timeZone = config.BIRTHDAY_NOTIFICATION_TIME_ZONE
): { dateKey: string; month: number; day: number } => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = value("year");
  const month = value("month");
  const day = value("day");

  return { dateKey: `${year}-${month}-${day}`, month: Number(month), day: Number(day) };
};

const birthdayMatches = (birthDate: Date, month: number, day: number): boolean =>
  birthDate.getUTCMonth() + 1 === month && birthDate.getUTCDate() === day;

export interface NotificationActor {
  userId?: string;
  clinicId?: string;
  role: string;
  permissions?: string[];
}

export interface PointsCreditNotificationJob {
  memberId: string;
  newBalance: number;
  milestoneReached: boolean;
  tierChanged: boolean;
}

export interface NotificationJobQueue {
  enqueueNotification(notificationId: string, delayMs?: number): Promise<void>;
  enqueueDelivery(deliveryId: string, delayMs?: number): Promise<void>;
  enqueuePointsCredit(job: PointsCreditNotificationJob): Promise<void>;
}

/**
 * How a message reaches an Apple card.
 *
 * Apple has no free-form push, so a message is stored for the member and the card is
 * refreshed: the rebuilt pass carries it in a field whose changeMessage fires on change.
 * A port, so this module never imports the wallet engine's sync internals and tests need
 * no network.
 *
 * Resolves only once the refreshed pass has been published and the device told (a wallet
 * outage rejects), because the delivery is marked SENT on the strength of it.
 */
export interface AppleCardRefresher {
  refreshMemberCard(memberId: string): Promise<void>;
}

export interface NotificationCounts {
  total: number;
  sent: number;
  downgraded: number;
  failed: number;
  skipped: number;
}

export interface BirthdayAutomationResult {
  date: string;
  clinicsChecked: number;
  candidates: number;
  notificationsCreated: number;
  deliveriesCreated: number;
}

export interface BonoReminderResult {
  /** The month the run is for, "YYYY-MM" in the automation's time zone. */
  month: string;
  clinicsChecked: number;
  candidates: number;
  notificationsCreated: number;
  deliveriesCreated: number;
}

type NotificationRecord = Awaited<ReturnType<NotificationService["findNotification"]>>;

export class NotificationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly wallet: WalletPassEngine,
    private readonly quota: NotificationQuotaService,
    private readonly jobs: NotificationJobQueue,
    /** Null where Apple cards cannot be refreshed (no signing material / card secret). */
    private readonly appleCards: AppleCardRefresher | null = null
  ) {}

  async broadcast(
    clinicId: string,
    input: NotificationMessageInput,
    actor: NotificationActor,
    idempotencyKey?: string
  ) {
    this.assertSender(actor, clinicId);

    const existing = await this.findIdempotent(clinicId, idempotencyKey);
    if (existing) return existing;

    await this.assertMarketingEnabled(clinicId);
    await this.assertBroadcastCapacity(clinicId);
    await this.googleClassForClinic(clinicId);

    const notification = await this.prisma.notification.create({
      data: {
        clinicId,
        type: NotificationType.BROADCAST,
        header: input.header,
        body: input.body,
        actionUrl: input.actionUrl,
        notify: input.notify,
        scheduledAt: input.scheduledAt,
        createdBy: actor.userId,
        idempotencyKey
      }
    });

    await this.audit(
      notification.id,
      clinicId,
      actor,
      "BROADCAST_CREATED",
      await this.memberCount(clinicId)
    );
    await this.jobs.enqueueNotification(notification.id, this.delayFor(input.scheduledAt));

    return notification;
  }

  async segment(
    clinicId: string,
    input: SegmentNotificationInput,
    actor: NotificationActor,
    idempotencyKey?: string
  ) {
    this.assertSender(actor, clinicId);

    const existing = await this.findIdempotent(clinicId, idempotencyKey);
    if (existing) return existing;

    await this.assertMarketingEnabled(clinicId);
    const members = await this.resolveSegment(clinicId, input.segment);
    const appleMemberIds = await this.syncedAppleMemberIds({ clinicId });

    const notification = await this.prisma.notification.create({
      data: {
        clinicId,
        type: NotificationType.SEGMENT,
        header: input.header,
        body: input.body,
        actionUrl: input.actionUrl,
        notify: input.notify,
        segmentJson: input.segment as Prisma.InputJsonValue,
        scheduledAt: input.scheduledAt,
        createdBy: actor.userId,
        idempotencyKey,
        deliveries: {
          // Google for everyone, as before (a member with no pass is skipped when processed);
          // Apple only where a synced Apple card exists, since there is nothing to refresh
          // otherwise.
          create: members.flatMap((member) => [
            {
              memberId: member.id,
              provider: WalletProviderType.GOOGLE,
              status: NotificationDeliveryStatus.QUEUED
            },
            ...(appleMemberIds.has(member.id)
              ? [
                  {
                    memberId: member.id,
                    provider: WalletProviderType.APPLE,
                    status: NotificationDeliveryStatus.QUEUED
                  }
                ]
              : [])
          ])
        }
      }
    });

    await this.audit(
      notification.id,
      clinicId,
      actor,
      "SEGMENT_CREATED",
      members.length,
      input.segment
    );

    if (members.length === 0) {
      await this.refreshNotificationStatus(notification.id, notification);
      return (await this.findNotification(notification.id)) ?? notification;
    }

    for (const chunk of this.chunks(members, 100)) {
      const deliveries = await this.prisma.notificationDelivery.findMany({
        where: {
          notificationId: notification.id,
          memberId: { in: chunk.map((member) => member.id) }
        },
        select: { id: true }
      });

      await Promise.all(
        deliveries.map((delivery) =>
          this.jobs.enqueueDelivery(delivery.id, this.delayFor(input.scheduledAt))
        )
      );
    }

    return notification;
  }

  async single(
    memberId: string,
    input: NotificationMessageInput,
    actor: NotificationActor,
    idempotencyKey?: string
  ) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, erasedAt: null },
      select: { id: true, clinicId: true }
    });

    if (!member) throw new NotificationNotFoundError("Member not found");

    this.assertSender(actor, member.clinicId);

    const existing = await this.findIdempotent(member.clinicId, idempotencyKey);
    if (existing) return existing;

    await this.assertMarketingEnabled(member.clinicId);

    const hasApple = (await this.syncedAppleMemberIds({ memberId: member.id })).has(member.id);

    const notification = await this.prisma.notification.create({
      data: {
        clinicId: member.clinicId,
        type: NotificationType.SINGLE,
        header: input.header,
        body: input.body,
        actionUrl: input.actionUrl,
        notify: input.notify,
        createdBy: actor.userId,
        idempotencyKey,
        deliveries: {
          create: [
            {
              memberId: member.id,
              provider: WalletProviderType.GOOGLE,
              status: NotificationDeliveryStatus.QUEUED
            },
            ...(hasApple
              ? [
                  {
                    memberId: member.id,
                    provider: WalletProviderType.APPLE,
                    status: NotificationDeliveryStatus.QUEUED
                  }
                ]
              : [])
          ]
        }
      },
      include: { deliveries: { select: { id: true } } }
    });

    await this.audit(notification.id, member.clinicId, actor, "SINGLE_CREATED", 1);
    await Promise.all(
      notification.deliveries.map((delivery) => this.jobs.enqueueDelivery(delivery.id))
    );

    return notification;
  }

  async onPointsCredited(
    memberId: string,
    newBalance: number,
    flags: { milestoneReached: boolean; tierChanged: boolean }
  ): Promise<void> {
    await this.jobs.enqueuePointsCredit({ memberId, newBalance, ...flags });
  }

  async runBirthdayAutomations(
    now = new Date(),
    timeZone = config.BIRTHDAY_NOTIFICATION_TIME_ZONE
  ): Promise<BirthdayAutomationResult> {
    const today = birthdayDay(now, timeZone);
    const result: BirthdayAutomationResult = {
      date: today.dateKey,
      clinicsChecked: 0,
      candidates: 0,
      notificationsCreated: 0,
      deliveriesCreated: 0
    };
    const clinics = await this.prisma.clinic.findMany({
      where: { isActive: true },
      include: { notificationSettings: true },
      orderBy: { createdAt: "asc" }
    });

    for (const clinic of clinics) {
      result.clinicsChecked += 1;
      const settings =
        clinic.notificationSettings ??
        (await this.prisma.clinicNotificationSettings.upsert({
          where: { clinicId: clinic.id },
          create: { clinicId: clinic.id },
          update: {}
        }));

      if (!settings.marketingEnabled || !settings.birthdayEnabled) {
        continue;
      }

      const members = await this.prisma.member.findMany({
        where: {
          clinicId: clinic.id,
          erasedAt: null,
          consentMarketing: true,
          birthDate: { not: null }
        },
        include: { walletObjects: true },
        orderBy: { createdAt: "asc" }
      });
      const candidates = members.filter((member) => {
        if (!member.birthDate || !birthdayMatches(member.birthDate, today.month, today.day)) {
          return false;
        }

        return member.walletObjects.some(
          (walletObject) =>
            walletObject.status === WalletSyncStatus.SYNCED &&
            (walletObject.provider === WalletProviderType.GOOGLE ||
              walletObject.provider === WalletProviderType.APPLE)
        );
      });

      result.candidates += candidates.length;

      if (candidates.length > 0) {
        const idempotencyKey = `birthday:${clinic.id}:${today.dateKey}`;
        const existing = await this.findIdempotent(clinic.id, idempotencyKey);
        const deliveries = candidates.flatMap((member) =>
          member.walletObjects
            .filter(
              (walletObject) =>
                walletObject.status === WalletSyncStatus.SYNCED &&
                (walletObject.provider === WalletProviderType.GOOGLE ||
                  walletObject.provider === WalletProviderType.APPLE)
            )
            .map((walletObject) => ({
              memberId: member.id,
              provider: walletObject.provider,
              status: NotificationDeliveryStatus.QUEUED
            }))
        );

        if (existing) {
          const existingDeliveries = await this.prisma.notificationDelivery.findMany({
            where: { notificationId: existing.id },
            select: { id: true, memberId: true, provider: true, status: true }
          });
          const existingKeys = new Set(
            existingDeliveries.map((delivery) => `${delivery.memberId}:${delivery.provider}`)
          );
          const missingDeliveries = deliveries.filter(
            (delivery) => !existingKeys.has(`${delivery.memberId}:${delivery.provider}`)
          );
          const createdDeliveries = await Promise.all(
            missingDeliveries.map((delivery) =>
              this.prisma.notificationDelivery.create({
                data: { notificationId: existing.id, ...delivery },
                select: { id: true }
              })
            )
          );
          const queuedDeliveryIds = [
            ...existingDeliveries
              .filter((delivery) => delivery.status === NotificationDeliveryStatus.QUEUED)
              .map((delivery) => delivery.id),
            ...createdDeliveries.map((delivery) => delivery.id)
          ];

          await Promise.all(
            queuedDeliveryIds.map((deliveryId) => this.jobs.enqueueDelivery(deliveryId))
          );
          result.deliveriesCreated += createdDeliveries.length;
        } else {
          const notification = await this.prisma.notification.create({
            data: {
              clinicId: clinic.id,
              type: NotificationType.BIRTHDAY,
              header: settings.birthdayHeader,
              body: settings.birthdayBody,
              notify: settings.birthdayNotify,
              idempotencyKey,
              segmentJson: {
                automation: "birthday",
                date: today.dateKey,
                timeZone
              },
              deliveries: { create: deliveries }
            },
            include: { deliveries: { select: { id: true } } }
          });

          await this.audit(
            notification.id,
            clinic.id,
            { role: "SYSTEM" },
            "BIRTHDAY_CREATED",
            candidates.length,
            {
              date: today.dateKey,
              timeZone
            }
          );

          await Promise.all(
            notification.deliveries.map((delivery) => this.jobs.enqueueDelivery(delivery.id))
          );

          result.notificationsCreated += 1;
          result.deliveriesCreated += notification.deliveries.length;
        }
      }

      await this.prisma.clinicNotificationSettings.update({
        where: { clinicId: clinic.id },
        data: { birthdayLastRunDate: today.dateKey }
      });
    }

    return result;
  }

  /**
   * The monthly "you have sessions left" automation: on the 1st, to every member holding a
   * bono with sessions left and a synced pass.
   *
   * NOT gated on marketingEnabled or consentMarketing (2026-10 product decision): the
   * sessions are already paid for. The clinic's off switch is bonoReminderEnabled.
   * Idempotent by (clinic, month).
   */
  async runBonoReminderAutomations(
    now = new Date(),
    timeZone = config.BIRTHDAY_NOTIFICATION_TIME_ZONE
  ): Promise<BonoReminderResult> {
    const today = birthdayDay(now, timeZone);
    const month = today.dateKey.slice(0, 7);
    const result: BonoReminderResult = {
      month,
      clinicsChecked: 0,
      candidates: 0,
      notificationsCreated: 0,
      deliveriesCreated: 0
    };

    // The cron ticks daily; this gate is what makes the send monthly.
    if (today.day !== 1) return result;

    const clinics = await this.prisma.clinic.findMany({
      where: { isActive: true },
      include: { notificationSettings: true },
      orderBy: { createdAt: "asc" }
    });

    for (const clinic of clinics) {
      result.clinicsChecked += 1;
      const settings =
        clinic.notificationSettings ??
        (await this.prisma.clinicNotificationSettings.upsert({
          where: { clinicId: clinic.id },
          create: { clinicId: clinic.id },
          update: {}
        }));

      if (!settings.bonoReminderEnabled) continue;

      const members = await this.prisma.member.findMany({
        where: {
          clinicId: clinic.id,
          erasedAt: null,
          bonos: { some: { status: MemberBonoStatus.ACTIVE } }
        },
        include: { walletObjects: true },
        orderBy: { createdAt: "asc" }
      });
      const candidates = members.filter((member) =>
        member.walletObjects.some(
          (walletObject) =>
            walletObject.status === WalletSyncStatus.SYNCED &&
            (walletObject.provider === WalletProviderType.GOOGLE ||
              walletObject.provider === WalletProviderType.APPLE)
        )
      );

      result.candidates += candidates.length;

      if (candidates.length > 0) {
        const idempotencyKey = `bono:${clinic.id}:${month}`;
        const existing = await this.findIdempotent(clinic.id, idempotencyKey);
        const deliveries = candidates.flatMap((member) =>
          member.walletObjects
            .filter(
              (walletObject) =>
                walletObject.status === WalletSyncStatus.SYNCED &&
                (walletObject.provider === WalletProviderType.GOOGLE ||
                  walletObject.provider === WalletProviderType.APPLE)
            )
            .map((walletObject) => ({
              memberId: member.id,
              provider: walletObject.provider,
              status: NotificationDeliveryStatus.QUEUED
            }))
        );

        if (existing) {
          // A retry after a crash between the two halves: deliver what is missing.
          const existingDeliveries = await this.prisma.notificationDelivery.findMany({
            where: { notificationId: existing.id },
            select: { id: true, memberId: true, provider: true, status: true }
          });
          const known = new Set(
            existingDeliveries.map((delivery) => `${delivery.memberId}:${delivery.provider}`)
          );
          const missing = deliveries.filter(
            (delivery) => !known.has(`${delivery.memberId}:${delivery.provider}`)
          );
          const createdDeliveries = await Promise.all(
            missing.map((delivery) =>
              this.prisma.notificationDelivery.create({
                data: { notificationId: existing.id, ...delivery },
                select: { id: true }
              })
            )
          );
          const queuedDeliveryIds = [
            ...existingDeliveries
              .filter((delivery) => delivery.status === NotificationDeliveryStatus.QUEUED)
              .map((delivery) => delivery.id),
            ...createdDeliveries.map((delivery) => delivery.id)
          ];

          await Promise.all(
            queuedDeliveryIds.map((deliveryId) => this.jobs.enqueueDelivery(deliveryId))
          );
          result.deliveriesCreated += createdDeliveries.length;
        } else {
          const notification = await this.prisma.notification.create({
            data: {
              clinicId: clinic.id,
              type: NotificationType.BONO_REMINDER,
              header: settings.bonoReminderHeader,
              body: settings.bonoReminderBody,
              notify: settings.bonoReminderNotify,
              idempotencyKey,
              segmentJson: { automation: "bono_reminder", month, timeZone },
              deliveries: { create: deliveries }
            },
            include: { deliveries: { select: { id: true } } }
          });

          await this.audit(
            notification.id,
            clinic.id,
            { role: "SYSTEM" },
            "BONO_REMINDER_CREATED",
            candidates.length,
            { month, timeZone }
          );

          await Promise.all(
            notification.deliveries.map((delivery) => this.jobs.enqueueDelivery(delivery.id))
          );

          result.notificationsCreated += 1;
          result.deliveriesCreated += notification.deliveries.length;
        }
      }

      await this.prisma.clinicNotificationSettings.update({
        where: { clinicId: clinic.id },
        data: { bonoReminderLastRunMonth: month }
      });
    }

    return result;
  }

  async processNotification(notificationId: string): Promise<void> {
    const notification = await this.findNotification(notificationId);

    if (!notification) throw new NotificationNotFoundError();
    if (notification.status === NotificationStatus.CANCELLED) return;

    if (
      notification.status === NotificationStatus.SENT ||
      // Reachable now that Apple deliveries can fail after the class message went out.
      notification.status === NotificationStatus.PARTIAL_FAILED
    ) {
      // A retry after the class message went out but before the Apple fan-out finished:
      // the fan-out is idempotent, the Google message must not be sent twice.
      if (notification.type === NotificationType.BROADCAST) {
        await this.fanOutAppleBroadcast(notification);
      }

      return;
    }

    if (notification.type !== NotificationType.BROADCAST) return;

    const walletClass = await this.googleClassForClinic(notification.clinicId);

    await this.prisma.notification.update({
      where: { id: notification.id },
      data: { status: NotificationStatus.PROCESSING }
    });

    try {
      const message = await this.wallet.addClassMessage(walletClass.externalClassId, {
        header: notification.header,
        body: this.bodyWithAction(notification.body, notification.actionUrl),
        notify: notification.notify,
        actionUrl: notification.actionUrl ?? undefined
      });

      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { status: NotificationStatus.SENT, providerMessageId: message.messageId }
      });
      await this.countManualNotification(notification.clinicId, notification.type);

      console.info("[notifications] broadcast sent", {
        notificationId: notification.id,
        clinicId: notification.clinicId
      });
    } catch (error) {
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { status: NotificationStatus.FAILED }
      });
      throw error;
    }

    // Outside the try on purpose: the Google message is already out, so a failure here must
    // not mark the broadcast FAILED and must not repeat it on retry.
    await this.fanOutAppleBroadcast(notification);
  }

  /**
   * A broadcast is one class message for Google, but Apple has no class-wide message: each
   * member with a synced Apple card gets a delivery of their own, queued as its own job so
   * a large clinic is refreshed at the queue's pace rather than all at once.
   *
   * Idempotent: only members without an Apple delivery for this notification get one, and
   * only deliveries still QUEUED are enqueued.
   */
  private async fanOutAppleBroadcast(notification: {
    id: string;
    clinicId: string;
  }): Promise<void> {
    const memberIds = [...(await this.syncedAppleMemberIds({ clinicId: notification.clinicId }))];

    if (memberIds.length === 0) return;

    const existing = await this.prisma.notificationDelivery.findMany({
      where: { notificationId: notification.id, provider: WalletProviderType.APPLE },
      select: { memberId: true, provider: true }
    });
    const known = new Set(existing.map((delivery) => delivery.memberId));
    const missing = memberIds.filter((memberId) => !known.has(memberId));

    for (const chunk of this.chunks(missing, 500)) {
      await this.prisma.notificationDelivery.createMany({
        data: chunk.map((memberId) => ({
          notificationId: notification.id,
          memberId,
          provider: WalletProviderType.APPLE,
          status: NotificationDeliveryStatus.QUEUED
        }))
      });
    }

    const queued = await this.prisma.notificationDelivery.findMany({
      where: {
        notificationId: notification.id,
        provider: WalletProviderType.APPLE,
        status: NotificationDeliveryStatus.QUEUED
      },
      select: { id: true }
    });

    for (const chunk of this.chunks(queued, 100)) {
      await Promise.all(chunk.map((delivery) => this.jobs.enqueueDelivery(delivery.id)));
    }
  }

  /** Members (not erased) holding a synced Apple card, of one clinic or one member. */
  private async syncedAppleMemberIds(
    scope: { clinicId: string } | { memberId: string }
  ): Promise<Set<string>> {
    const objects = await this.prisma.walletObject.findMany({
      where: {
        provider: WalletProviderType.APPLE,
        status: WalletSyncStatus.SYNCED,
        ...("memberId" in scope ? { memberId: scope.memberId } : {}),
        member: { ...("clinicId" in scope ? { clinicId: scope.clinicId } : {}), erasedAt: null }
      },
      select: { memberId: true }
    });

    return new Set(objects.map((object) => object.memberId));
  }

  async processDelivery(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      include: { notification: true, member: { include: { walletObjects: true } } }
    });

    if (!delivery) throw new NotificationNotFoundError("Notification delivery not found");
    if (delivery.notification.status === NotificationStatus.CANCELLED) return;
    if (delivery.status !== NotificationDeliveryStatus.QUEUED) return;

    if (delivery.provider === WalletProviderType.APPLE) {
      await this.processAppleDelivery(delivery);
      return;
    }

    const object = delivery.member.walletObjects.find(
      (walletObject) =>
        walletObject.provider === delivery.provider &&
        walletObject.status === WalletSyncStatus.SYNCED
    );

    if (!object) {
      await this.markDelivery(delivery.id, NotificationDeliveryStatus.SKIPPED, "NO_GOOGLE_PASS");
      await this.refreshNotificationStatus(delivery.notificationId, delivery.notification);
      return;
    }

    const wantsPush = delivery.notification.notify;
    const canPush = wantsPush ? await this.quota.canMarketingPush(object.externalObjectId) : false;
    const notify = wantsPush && canPush;
    const status =
      wantsPush && !notify
        ? NotificationDeliveryStatus.DOWNGRADED
        : NotificationDeliveryStatus.SENT;

    try {
      const message = await this.wallet.addObjectMessage(object.externalObjectId, {
        header: delivery.notification.header,
        body: this.bodyWithAction(delivery.notification.body, delivery.notification.actionUrl),
        notify,
        actionUrl: delivery.notification.actionUrl ?? undefined
      });

      if (notify) await this.quota.recordPush(object.externalObjectId);

      await this.markDelivery(delivery.id, status, null, message.messageId);
      await this.refreshNotificationStatus(delivery.notificationId, delivery.notification);
    } catch (error) {
      if (error instanceof WalletNotificationQuotaExceededError && wantsPush) {
        const message = await this.wallet.addObjectMessage(object.externalObjectId, {
          header: delivery.notification.header,
          body: this.bodyWithAction(delivery.notification.body, delivery.notification.actionUrl),
          notify: false,
          actionUrl: delivery.notification.actionUrl ?? undefined
        });

        await this.markDelivery(
          delivery.id,
          NotificationDeliveryStatus.DOWNGRADED,
          "QUOTA_EXCEEDED",
          message.messageId
        );
        await this.refreshNotificationStatus(delivery.notificationId, delivery.notification);
        return;
      }

      if (error instanceof WalletNotificationTransientError) throw error;

      await this.markDelivery(
        delivery.id,
        error instanceof WalletNotificationNotFoundError
          ? NotificationDeliveryStatus.SKIPPED
          : NotificationDeliveryStatus.FAILED,
        error instanceof Error ? error.name : "UNKNOWN"
      );
      await this.refreshNotificationStatus(delivery.notificationId, delivery.notification);
    }
  }

  /**
   * An Apple message: store it as the member's latest, refresh the card so the changed
   * field notifies, and call the delivery SENT only once that refresh succeeded.
   *
   * Does not touch the Google notification quota: Apple's lock-screen notifications are
   * not metered by it.
   *
   * A failed refresh marks FAILED and does not throw, as a non-transient Google failure
   * does, so the queue does not retry-storm a wallet outage. The stored message stays: the
   * next successful card sync (a points change, say) shows it.
   */
  private async processAppleDelivery(delivery: {
    id: string;
    notificationId: string;
    memberId: string;
    notification: NonNullable<NotificationRecord>;
    member: { walletObjects: Array<{ provider: WalletProviderType; status: WalletSyncStatus }> };
  }): Promise<void> {
    const finish = async (status: NotificationDeliveryStatus, errorCode: string | null) => {
      await this.markDelivery(delivery.id, status, errorCode);
      await this.refreshNotificationStatus(delivery.notificationId, delivery.notification);
    };
    const hasApplePass = delivery.member.walletObjects.some(
      (walletObject) =>
        walletObject.provider === WalletProviderType.APPLE &&
        walletObject.status === WalletSyncStatus.SYNCED
    );

    if (!hasApplePass) {
      await finish(NotificationDeliveryStatus.SKIPPED, "NO_APPLE_PASS");
      return;
    }

    if (!this.appleCards) {
      await finish(NotificationDeliveryStatus.FAILED, "APPLE_REFRESH_UNAVAILABLE");
      return;
    }

    const message = {
      header: delivery.notification.header,
      body: delivery.notification.body,
      sentAt: new Date(),
      notificationId: delivery.notification.id
    };

    await this.prisma.memberWalletMessage.upsert({
      where: { memberId: delivery.memberId },
      create: { memberId: delivery.memberId, ...message },
      update: message
    });

    try {
      await this.appleCards.refreshMemberCard(delivery.memberId);
    } catch (error) {
      console.warn("[notifications] apple card refresh failed", {
        deliveryId: delivery.id,
        error: error instanceof Error ? error.name : "UNKNOWN"
      });
      await finish(NotificationDeliveryStatus.FAILED, "APPLE_REFRESH_FAILED");
      return;
    }

    await finish(NotificationDeliveryStatus.SENT, null);
  }

  async processPointsCredit(job: PointsCreditNotificationJob): Promise<void> {
    const member = await this.prisma.member.findFirst({
      where: { id: job.memberId, erasedAt: null },
      include: { walletObjects: true }
    });

    if (!member) return;

    // The job carries the ledger's balance. A programme centre keeps progress in euros and shows
    // points (ten per euro), the unit the pass was built with; sending the raw figure here would
    // overwrite the card with the money spent.
    const shownBalance = await displayPoints(this.prisma, member.clinicId, job.newBalance);

    const object = member.walletObjects.find(
      (walletObject) =>
        walletObject.provider === WalletProviderType.GOOGLE &&
        walletObject.status === WalletSyncStatus.SYNCED
    );

    const notification = await this.prisma.notification.create({
      data: {
        clinicId: member.clinicId,
        type: job.tierChanged ? NotificationType.TIER : NotificationType.POINTS,
        header: "Puntos actualizados",
        body: `Tu saldo ahora es ${shownBalance}`,
        notify: false,
        deliveries: {
          create: {
            memberId: member.id,
            provider: WalletProviderType.GOOGLE,
            status: object ? NotificationDeliveryStatus.QUEUED : NotificationDeliveryStatus.SKIPPED,
            errorCode: object ? undefined : "NO_GOOGLE_PASS"
          }
        }
      },
      include: { deliveries: true }
    });

    if (!object) {
      await this.refreshNotificationStatus(notification.id, notification);
      return;
    }

    const settings = await this.settingsFor(member.clinicId);
    const shouldNotify =
      settings.notifyOnCredit === ClinicNotifyOnCredit.ALWAYS ||
      (settings.notifyOnCredit === ClinicNotifyOnCredit.MILESTONE_AND_TIER &&
        (job.milestoneReached || job.tierChanged));
    const notify = shouldNotify && (await this.quota.canPush(object.externalObjectId));

    try {
      await this.wallet.patchPoints(object.externalObjectId, {
        points: shownBalance,
        tier: member.tier ?? undefined,
        notify
      });

      if (notify) await this.quota.recordPush(object.externalObjectId);

      await this.markDelivery(
        notification.deliveries[0].id,
        shouldNotify && !notify
          ? NotificationDeliveryStatus.DOWNGRADED
          : NotificationDeliveryStatus.SENT,
        shouldNotify && !notify ? "QUOTA_RESERVED" : null
      );
      await this.refreshNotificationStatus(notification.id, notification);
    } catch (error) {
      if (error instanceof WalletNotificationQuotaExceededError) {
        await this.wallet.patchPoints(object.externalObjectId, {
          points: shownBalance,
          tier: member.tier ?? undefined,
          notify: false
        });
        await this.markDelivery(
          notification.deliveries[0].id,
          NotificationDeliveryStatus.DOWNGRADED,
          "QUOTA_EXCEEDED"
        );
        await this.refreshNotificationStatus(notification.id, notification);
        return;
      }

      if (error instanceof WalletNotificationNotFoundError) {
        await this.markDelivery(
          notification.deliveries[0].id,
          NotificationDeliveryStatus.SKIPPED,
          "NOT_FOUND"
        );
        await this.refreshNotificationStatus(notification.id, notification);
        return;
      }

      throw error;
    }
  }

  async list(
    clinicId: string,
    filters: { status?: string; type?: string; cursor?: string },
    actor: NotificationActor
  ) {
    this.assertReader(actor, clinicId);

    const notifications = await this.prisma.notification.findMany({
      where: {
        clinicId,
        ...(filters.status ? { status: filters.status as NotificationStatus } : {}),
        ...(filters.type ? { type: filters.type as NotificationType } : {})
      },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {})
    });

    return {
      items: notifications.slice(0, PAGE_SIZE),
      nextCursor: notifications.length > PAGE_SIZE ? notifications[PAGE_SIZE].id : null
    };
  }

  async get(notificationId: string, actor: NotificationActor) {
    const notification = await this.findNotification(notificationId);

    if (!notification) throw new NotificationNotFoundError();
    this.assertReader(actor, notification.clinicId);

    return { notification, counts: await this.countsFor(notification) };
  }

  async delete(notificationId: string, actor: NotificationActor): Promise<void> {
    const notification = await this.findNotification(notificationId);

    if (!notification) throw new NotificationNotFoundError();
    this.assertSender(actor, notification.clinicId);

    await this.prisma.notification.update({
      where: { id: notification.id },
      data: { status: NotificationStatus.CANCELLED }
    });

    if (notification.type === NotificationType.BROADCAST && notification.providerMessageId) {
      const walletClass = await this.googleClassForClinic(notification.clinicId);
      await this.bestEffortRemove(
        { kind: "class", id: walletClass.externalClassId },
        notification.providerMessageId
      );
      return;
    }

    const deliveries = await this.prisma.notificationDelivery.findMany({
      where: { notificationId: notification.id, providerMessageId: { not: null } },
      include: { member: { include: { walletObjects: true } } }
    });

    await Promise.all(
      deliveries.map(async (delivery) => {
        const object = delivery.member.walletObjects.find(
          (walletObject) => walletObject.provider === WalletProviderType.GOOGLE
        );

        if (object && delivery.providerMessageId) {
          await this.bestEffortRemove(
            { kind: "object", id: object.externalObjectId },
            delivery.providerMessageId
          );
        }
      })
    );
  }

  async quotaForMember(memberId: string, actor: NotificationActor) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, erasedAt: null },
      include: { walletObjects: true }
    });

    if (!member) throw new NotificationNotFoundError("Member not found");
    this.assertReader(actor, member.clinicId);

    const object = member.walletObjects.find(
      (walletObject) => walletObject.provider === WalletProviderType.GOOGLE
    );

    if (!object) return { used: 0, remaining: 0, resetsAt: null };

    return this.quota.usage(object.externalObjectId);
  }

  async getSettings(clinicId: string, actor: NotificationActor) {
    this.assertReader(actor, clinicId);

    return this.settingsFor(clinicId);
  }

  async updateSettings(
    clinicId: string,
    input: NotificationSettingsInput,
    actor: NotificationActor
  ) {
    this.assertSender(actor, clinicId);

    return this.prisma.clinicNotificationSettings.upsert({
      where: { clinicId },
      create: { clinicId, ...input },
      update: input
    });
  }

  async getLocations(clinicId: string, actor: NotificationActor) {
    this.assertReader(actor, clinicId);

    return this.prisma.clinicLocation.findMany({
      where: { clinicId },
      orderBy: { createdAt: "asc" }
    });
  }

  async setLocations(clinicId: string, locations: ClinicLocationInput[], actor: NotificationActor) {
    this.assertSender(actor, clinicId);

    const walletClass = await this.googleClassForClinic(clinicId);

    await this.wallet.setLocations(walletClass.externalClassId, locations);

    const [, ...savedLocations] = await this.prisma.$transaction([
      this.prisma.clinicLocation.deleteMany({ where: { clinicId } }),
      ...locations.map((location) =>
        this.prisma.clinicLocation.create({ data: { clinicId, ...location } })
      )
    ]);

    return savedLocations;
  }

  async resolveSegment(clinicId: string, segment: NotificationSegmentInput) {
    const members = await this.prisma.member.findMany({
      where: {
        clinicId,
        erasedAt: null,
        ...(segment.tier ? { tier: segment.tier } : {}),
        // The auto-created segment: every member holding a bono with sessions left.
        ...(segment.activeBono ? { bonos: { some: { status: MemberBonoStatus.ACTIVE } } } : {})
      },
      include: { pointsLedger: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { createdAt: "asc" }
    });
    const cutoff = segment.inactiveDays
      ? new Date(Date.now() - segment.inactiveDays * 24 * 60 * 60 * 1_000)
      : segment.lastVisitBefore;

    return members.filter((member) => {
      if (cutoff) {
        const lastVisitAt = member.pointsLedger[0]?.createdAt ?? member.createdAt;
        if (lastVisitAt >= cutoff) return false;
      }

      if (segment.categoryNotVisited) {
        const category = segment.categoryNotVisited.toLowerCase();
        const hasCategory = member.pointsLedger.some((entry) =>
          `${entry.reason ?? ""} ${entry.sourceRef ?? ""}`.toLowerCase().includes(category)
        );
        if (hasCategory) return false;
      }

      return true;
    });
  }

  private async findNotification(id: string) {
    return this.prisma.notification.findUnique({ where: { id } });
  }

  private async findIdempotent(clinicId: string, idempotencyKey?: string) {
    if (!idempotencyKey) return null;

    return this.prisma.notification.findFirst({ where: { clinicId, idempotencyKey } });
  }

  private async assertMarketingEnabled(clinicId: string): Promise<void> {
    const settings = await this.settingsFor(clinicId);

    if (!settings.marketingEnabled) {
      throw new NotificationForbiddenError("Marketing notifications are disabled for this clinic");
    }
  }

  private async assertBroadcastCapacity(clinicId: string): Promise<void> {
    const count = await this.prisma.notification.count({
      where: {
        clinicId,
        type: NotificationType.BROADCAST,
        createdAt: { gte: new Date(Date.now() - BROADCAST_WINDOW_MS) },
        status: { not: NotificationStatus.CANCELLED }
      }
    });

    if (count >= BROADCAST_LIMIT) {
      throw new NotificationRateLimitError("Broadcast limit reached for this clinic");
    }
  }

  private async settingsFor(clinicId: string) {
    return this.prisma.clinicNotificationSettings.upsert({
      where: { clinicId },
      create: { clinicId },
      update: {}
    });
  }

  private async googleClassForClinic(clinicId: string) {
    const walletClass = await this.prisma.walletClass.findFirst({
      where: {
        provider: WalletProviderType.GOOGLE,
        status: WalletSyncStatus.SYNCED,
        clinicTemplate: { clinicId }
      }
    });

    if (!walletClass) throw new NotificationNotFoundError("Clinic has no Google Wallet class");

    return walletClass;
  }

  private async memberCount(clinicId: string): Promise<number> {
    return this.prisma.member.count({ where: { clinicId, erasedAt: null } });
  }

  private async audit(
    notificationId: string | null,
    clinicId: string,
    actor: NotificationActor,
    action: string,
    recipientCount: number,
    payload?: unknown
  ): Promise<void> {
    await this.prisma.notificationAuditLog.create({
      data: {
        notificationId,
        clinicId,
        actorId: actor.userId,
        action,
        recipientCount,
        payloadJson: payload === undefined ? undefined : (payload as Prisma.InputJsonValue)
      }
    });
  }

  private async markDelivery(
    deliveryId: string,
    status: NotificationDeliveryStatus,
    errorCode?: string | null,
    providerMessageId?: string
  ): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status,
        errorCode,
        providerMessageId,
        sentAt:
          status === NotificationDeliveryStatus.SENT ||
          status === NotificationDeliveryStatus.DOWNGRADED
            ? new Date()
            : undefined
      }
    });
  }

  private async refreshNotificationStatus(
    notificationId: string,
    notificationRecord?: { clinicId: string; type: NotificationType; status: NotificationStatus }
  ): Promise<void> {
    const notification = notificationRecord ?? (await this.findNotification(notificationId));

    if (!notification) throw new NotificationNotFoundError();

    const deliveries = await this.prisma.notificationDelivery.findMany({
      where: { notificationId },
      select: { status: true }
    });

    if (deliveries.some((delivery) => delivery.status === NotificationDeliveryStatus.QUEUED)) {
      return;
    }

    const failed = deliveries.some(
      (delivery) => delivery.status === NotificationDeliveryStatus.FAILED
    );
    // A broadcast's deliveries are only the Apple ones: its Google class message has
    // already gone out by the time any of them exists, so it is never wholly FAILED.
    const completed =
      notification.type === NotificationType.BROADCAST ||
      deliveries.some(
        (delivery) =>
          delivery.status === NotificationDeliveryStatus.SENT ||
          delivery.status === NotificationDeliveryStatus.DOWNGRADED ||
          delivery.status === NotificationDeliveryStatus.SKIPPED
      );
    // "Envíos reales este mes" counts real sends, on either wallet: a notification whose
    // deliveries were all skipped or failed sent nothing and must not use up the plan.
    const reallySent = deliveries.some(
      (delivery) =>
        delivery.status === NotificationDeliveryStatus.SENT ||
        delivery.status === NotificationDeliveryStatus.DOWNGRADED
    );
    const nextStatus =
      failed && completed
        ? NotificationStatus.PARTIAL_FAILED
        : failed
          ? NotificationStatus.FAILED
          : NotificationStatus.SENT;

    await this.prisma.notification.update({
      where: { id: notificationId },
      data: { status: nextStatus }
    });

    if (
      reallySent &&
      notification.status !== NotificationStatus.SENT &&
      notification.status !== NotificationStatus.PARTIAL_FAILED &&
      (nextStatus === NotificationStatus.SENT || nextStatus === NotificationStatus.PARTIAL_FAILED)
    ) {
      await this.countManualNotification(notification.clinicId, notification.type);
    }
  }

  private async countsFor(
    notification: NonNullable<NotificationRecord>
  ): Promise<NotificationCounts> {
    if (notification.type === NotificationType.BROADCAST) {
      const total = await this.memberCount(notification.clinicId);

      if (notification.status === NotificationStatus.PARTIAL_FAILED) {
        // The class message went to everyone on Google; what failed are the per-member Apple
        // deliveries.
        const failed = await this.prisma.notificationDelivery.count({
          where: { notificationId: notification.id, status: NotificationDeliveryStatus.FAILED }
        });

        return { total, sent: Math.max(0, total - failed), downgraded: 0, failed, skipped: 0 };
      }

      const sent = notification.status === NotificationStatus.SENT ? total : 0;

      return {
        total,
        sent,
        downgraded: 0,
        failed: notification.status === NotificationStatus.FAILED ? total : 0,
        skipped: 0
      };
    }

    const rows = await this.prisma.notificationDelivery.groupBy({
      by: ["status"],
      where: { notificationId: notification.id },
      _count: { _all: true }
    });
    const count = (status: NotificationDeliveryStatus) =>
      rows.find((row) => row.status === status)?._count._all ?? 0;

    return {
      total: rows.reduce((sum, row) => sum + row._count._all, 0),
      sent: count(NotificationDeliveryStatus.SENT),
      downgraded: count(NotificationDeliveryStatus.DOWNGRADED),
      failed: count(NotificationDeliveryStatus.FAILED),
      skipped: count(NotificationDeliveryStatus.SKIPPED)
    };
  }

  private async countManualNotification(clinicId: string, type: NotificationType): Promise<void> {
    if (!MANUAL_NOTIFICATION_TYPES.has(type)) return;

    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: { notificationsUsedThisMonth: { increment: 1 } }
    });
  }

  private assertSender(actor: NotificationActor, clinicId: string): void {
    this.assertReader(actor, clinicId);

    if (!hasPermission(actor, PERMISSIONS.notificationsSend)) {
      throw new NotificationForbiddenError("Notifications permission is required");
    }
  }

  private assertReader(actor: NotificationActor, clinicId: string): void {
    if (actor.role.toUpperCase() === "VOONE_ADMIN") return;
    if (actor.clinicId !== clinicId) throw new NotificationForbiddenError();
    if (!hasPermission(actor, PERMISSIONS.notificationsSend)) {
      throw new NotificationForbiddenError("Notifications permission is required");
    }
  }

  private async bestEffortRemove(
    target: { kind: "class"; id: string } | { kind: "object"; id: string },
    messageId: string
  ): Promise<void> {
    try {
      await this.wallet.removeMessage(target, messageId);
    } catch (error) {
      console.warn("[notifications] message removal failed", {
        targetKind: target.kind,
        notificationMessageId: messageId,
        error: error instanceof Error ? error.name : "UNKNOWN"
      });
    }
  }

  private bodyWithAction(body: string, actionUrl?: string | null): string {
    return actionUrl ? `${body}\n${actionUrl}` : body;
  }

  private delayFor(scheduledAt?: Date): number | undefined {
    if (!scheduledAt) return undefined;

    return Math.max(0, scheduledAt.getTime() - Date.now());
  }

  private chunks<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }

    return chunks;
  }
}
