import {
  AutomationEvent,
  MemberBonoStatus,
  NotificationType,
  type PrismaClient
} from "@prisma/client";

import type { AutomationRecipient } from "../dispatch.service";
import { DAY_MS, type ScheduledTrigger, type TriggerContext } from "./types";

export const BONO_INACTIVE_DAYS = 30;

/**
 * EVT-003: a member whose active bono has gone 30 days without a session. Once per inactivity
 * streak: a reminder sent after the bono's last activity suppresses further ones until the
 * member uses a session again.
 */
export class BonoInactiveTrigger implements ScheduledTrigger {
  readonly event = AutomationEvent.BONO_INACTIVE;

  constructor(private readonly prisma: PrismaClient) {}

  isDue(): boolean {
    return true;
  }

  idempotencyKey(clinicId: string, today: { dateKey: string }): string {
    return `bono-inactive:${clinicId}:${today.dateKey}`;
  }

  async findRecipients({ clinicId, now }: TriggerContext): Promise<AutomationRecipient[]> {
    const cutoff = new Date(now.getTime() - BONO_INACTIVE_DAYS * DAY_MS);
    const bonos = await this.prisma.memberBono.findMany({
      where: { clinicId, status: MemberBonoStatus.ACTIVE, startedAt: { lte: cutoff } },
      select: { id: true, memberId: true, startedAt: true }
    });

    if (bonos.length === 0) return [];

    // Last session per bono in one query; a bono never used counts from the day it started.
    const lastVisits = await this.prisma.paidVisit.groupBy({
      by: ["memberBonoId"],
      where: { memberBonoId: { in: bonos.map((bono) => bono.id) } },
      _max: { occurredAt: true }
    });
    const lastVisitByBono = new Map(
      lastVisits.map((row) => [row.memberBonoId, row._max.occurredAt])
    );
    const inactive = bonos
      .map((bono) => ({
        memberId: bono.memberId,
        lastActivity: lastVisitByBono.get(bono.id) ?? bono.startedAt
      }))
      .filter((bono) => bono.lastActivity <= cutoff);

    if (inactive.length === 0) return [];

    const earliest = new Date(Math.min(...inactive.map((bono) => bono.lastActivity.getTime())));
    const reminders = await this.prisma.notificationDelivery.findMany({
      where: {
        memberId: { in: inactive.map((bono) => bono.memberId) },
        notification: {
          clinicId,
          type: NotificationType.BONO_REMINDER,
          createdAt: { gte: earliest }
        }
      },
      select: { memberId: true, notification: { select: { createdAt: true } } }
    });
    const latestReminder = new Map<string, number>();

    for (const { memberId, notification } of reminders) {
      latestReminder.set(
        memberId,
        Math.max(latestReminder.get(memberId) ?? 0, notification.createdAt.getTime())
      );
    }

    // Eligible if ANY of the member's inactive bonos has had no reminder since its last activity.
    const eligible = new Set(
      inactive
        .filter((bono) => (latestReminder.get(bono.memberId) ?? 0) <= bono.lastActivity.getTime())
        .map((bono) => bono.memberId)
    );

    return [...eligible].map((memberId) => ({ memberId }));
  }
}
