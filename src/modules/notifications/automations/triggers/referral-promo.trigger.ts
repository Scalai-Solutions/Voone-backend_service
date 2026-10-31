import { AutomationEvent, type PrismaClient } from "@prisma/client";

import type { ZonedDate } from "../../../../common/utils/zoned-time";
import type { AutomationRecipient } from "../dispatch.service";
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

    return members.map(({ id }) => ({ memberId: id }));
  }
}
