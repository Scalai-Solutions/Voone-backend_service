import { AutomationEvent, NotificationType, type PrismaClient } from "@prisma/client";

import type { AutomationDispatchService, AutomationRecipient } from "../dispatch.service";
import { DAY_MS, type ScheduledTrigger, type TriggerContext } from "./types";

/** How recent the visit that made it the member's 2nd (or later) must be. */
export const REVIEW_WINDOW_DAYS = 7;
export const REVIEW_MIN_VISITS = 2;

/**
 * Of `memberIds`, those with at least REVIEW_MIN_VISITS visits who were never asked for a review.
 * Shared by the instant send after a visit and the daily catch-up, so both apply the same rule.
 */
export const membersDueForReview = async (
  prisma: PrismaClient,
  clinicId: string,
  memberIds: readonly string[]
): Promise<string[]> => {
  if (memberIds.length === 0) return [];

  const [totals, alreadyAsked] = await Promise.all([
    prisma.paidVisit.groupBy({
      by: ["memberId"],
      where: { clinicId, memberId: { in: [...memberIds] } },
      _count: { _all: true },
      having: { memberId: { _count: { gte: REVIEW_MIN_VISITS } } }
    }),
    prisma.notificationDelivery.findMany({
      where: {
        memberId: { in: [...memberIds] },
        notification: { clinicId, type: NotificationType.REVIEW_REQUEST }
      },
      select: { memberId: true },
      distinct: ["memberId"]
    })
  ]);
  const asked = new Set(alreadyAsked.map((delivery) => delivery.memberId));

  return totals.map((row) => row.memberId).filter((memberId) => !asked.has(memberId));
};

/**
 * EVT-005, sent as soon as the visit that makes it the member's 2nd is recorded, whatever it
 * earned (a 0 € visit queues no points credit). Without this the request waited for the next
 * daily dispatcher run. One request per member, ever: the key is the
 * member, and the eligibility check skips anyone already asked by either path.
 */
export class ReviewRequestNotifier {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sender: AutomationDispatchService
  ) {}

  async notifyIfDue(input: { memberId: string; clinicId: string }) {
    const due = await membersDueForReview(this.prisma, input.clinicId, [input.memberId]);

    if (due.length === 0) return null;

    return this.sender.dispatch({
      clinicId: input.clinicId,
      event: AutomationEvent.REVIEW_REQUEST,
      idempotencyKey: `review:member:${input.memberId}`,
      recipients: [{ memberId: input.memberId }]
    });
  }
}

/** EVT-005: ask for a Google review after the 2nd visit, once per member (daily catch-up). */
export class ReviewRequestTrigger implements ScheduledTrigger {
  readonly event = AutomationEvent.REVIEW_REQUEST;

  constructor(private readonly prisma: PrismaClient) {}

  isDue(): boolean {
    return true;
  }

  idempotencyKey(clinicId: string, today: { dateKey: string }): string {
    return `review:${clinicId}:${today.dateKey}`;
  }

  async findRecipients({ clinicId, now }: TriggerContext): Promise<AutomationRecipient[]> {
    const recent = await this.prisma.paidVisit.findMany({
      where: {
        clinicId,
        occurredAt: { gte: new Date(now.getTime() - REVIEW_WINDOW_DAYS * DAY_MS) }
      },
      select: { memberId: true },
      distinct: ["memberId"]
    });

    if (recent.length === 0) return [];

    return (
      await membersDueForReview(
        this.prisma,
        clinicId,
        recent.map((visit) => visit.memberId)
      )
    ).map((memberId) => ({ memberId }));
  }
}
