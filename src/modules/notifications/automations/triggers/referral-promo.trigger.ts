import { AutomationEvent, type PrismaClient } from "@prisma/client";

import type { ZonedDate } from "../../../../common/utils/zoned-time";
import type { AutomationRecipient } from "../dispatch.service";
import { loadActiveProgram, nextReferralReward } from "../member-rewards";
import { DAY_MS, type ScheduledTrigger, type TriggerContext } from "./types";

/** "Active" for the referral nudge: a visit or points movement within this many days. */
export const REFERRAL_ACTIVE_DAYS = 90;

/** EVT-007: a monthly nudge, on the configured day of the month, to active members. */
export class ReferralPromoTrigger implements ScheduledTrigger {
  readonly event = AutomationEvent.REFERRAL_PROMO;

  constructor(
    private readonly prisma: PrismaClient,
    /** REFERRAL_PUSH_DAY_OF_MONTH. */
    private readonly dayOfMonth: number
  ) {}

  isDue(today: ZonedDate): boolean {
    return today.day === this.dayOfMonth;
  }

  idempotencyKey(clinicId: string, today: ZonedDate): string {
    return `referral:${clinicId}:${today.dateKey.slice(0, 7)}`;
  }

  async findRecipients({ clinicId, now }: TriggerContext): Promise<AutomationRecipient[]> {
    // Referral rewards are issued by the live programme; without one there is nothing to promise.
    const program = await loadActiveProgram(this.prisma, clinicId);

    if (!program) return [];

    const since = new Date(now.getTime() - REFERRAL_ACTIVE_DAYS * DAY_MS);
    const members = await this.prisma.member.findMany({
      where: {
        clinicId,
        erasedAt: null,
        consentMarketing: true,
        OR: [
          { paidVisits: { some: { occurredAt: { gte: since } } } },
          { pointsLedger: { some: { createdAt: { gte: since } } } }
        ]
      },
      select: { id: true }
    });

    const counted = await this.prisma.referral.groupBy({
      by: ["referrerId"],
      where: {
        clinicId,
        countedAt: { not: null },
        referrerId: { in: members.map(({ id }) => id) }
      },
      _count: { _all: true }
    });
    const countedBy = new Map(counted.map((row) => [row.referrerId, row._count._all]));

    // Each member hears about the reward their own next referral earns, not a clinic-wide one.
    return members.map(({ id }) => ({
      memberId: id,
      values: { referral_reward: nextReferralReward(program, countedBy.get(id) ?? 0) }
    }));
  }
}
