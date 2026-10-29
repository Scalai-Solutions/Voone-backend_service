import { MemberRewardKind, VisitKind, type Prisma } from "@prisma/client";

import { earnsProgress, MIN_EARNING_CENTS } from "./rules";

/**
 * Who earns double on a payment visit, decided in ONE place.
 *
 * The visit credit (VisitService) and the answer the reception screen shows before the visit
 * (GET .../rewards -> `doublePoints`) both call `pendingDouble`, so the screen and the credit can
 * never disagree about whether a visit will be doubled.
 *
 * Two things can double a visit, and the doubling is x2 IN TOTAL, never x4:
 *  - "referral": the member was referred and has not yet had a payment that earned progress.
 *    Only that first earning payment counts; a medicine-only basket, a prepaid session and a
 *    visit that earned nothing are not "the first visit".
 *  - "perk": a waiting `doble` perk (a tier milestone's gift), spent by the next payment.
 *
 * RULING when both are present at the same visit: the visit is x2 and the REFERRAL is what
 * doubles it. The waiting perk is NOT consumed by that visit: the client keeps what they
 * earned, and the perk doubles their next payment.
 */

export const DOUBLE_PERK = "doble";

export type DoubleReason = "perk" | "referral";

/** What the reception screen is told, and what the card will say. */
export interface DoublePoints {
  applies: boolean;
  reason: DoubleReason | null;
  /** When the waiting perk lapses (ISO); null for a referral, which does not lapse. */
  until: string | null;
}

export const NO_DOUBLE: DoublePoints = { applies: false, reason: null, until: null };

/** The reason the ledger row for a referral-doubled visit carries. */
export const REFERRAL_DOUBLE_REASON = "Visita de pago (doble por recomendación)";

type Db = Pick<
  Prisma.TransactionClient,
  "memberReward" | "referral" | "paidVisit" | "pointsTransaction"
>;

/** A payment that earned progress: the only kind that can be a referred client's first. */
const earningPayment = {
  kind: VisitKind.PAYMENT,
  amountCents: { gte: MIN_EARNING_CENTS }
} as const;

/**
 * The decision itself, from the two facts it depends on. Pure, so the visit credit, the rewards
 * lookup and the wallet card all go through it: a referred member with no earning payment yet is
 * doubled by the REFERRAL (the perk, if any, is kept); otherwise a waiting perk doubles it.
 */
export const chooseDouble = (
  referralPending: boolean,
  perk: { id: string; expiresAt: Date } | null
): DoublePoints & { perkId: string | null } => {
  if (referralPending) return { applies: true, reason: "referral", until: null, perkId: null };

  return perk
    ? { applies: true, reason: "perk", until: perk.expiresAt.toISOString(), perkId: perk.id }
    : { ...NO_DOUBLE, perkId: null };
};

/** The order a member's waiting perks are spent in; the wallet card lists them the same way. */
export const PERK_ORDER = [{ expiresAt: "asc" }, { issuedAt: "asc" }, { id: "asc" }] as const;

const waitingPerk = (db: Db, memberId: string, at: Date) =>
  db.memberReward.findFirst({
    where: {
      memberId,
      kind: MemberRewardKind.VENTAJA,
      redeemedAt: null,
      expiresAt: { gt: at },
      detail: { path: ["perk"], equals: DOUBLE_PERK }
    },
    orderBy: [...PERK_ORDER]
  });

/**
 * Was the member referred and has no payment that earned progress yet: the referral's x2 is still
 * waiting. The referral is looked up first and the paid visit only when there is one, so a member
 * nobody referred costs a single indexed read. Shared by the visit credit, the reception lookup and
 * the wallet card.
 */
export const isReferralPending = async (
  db: Pick<Db, "referral" | "paidVisit">,
  memberId: string
): Promise<boolean> => {
  const referral = await db.referral.findUnique({
    where: { referredId: memberId },
    select: { id: true }
  });

  if (!referral) return false;

  const paid = await db.paidVisit.findFirst({
    where: { memberId, ...earningPayment },
    select: { id: true }
  });

  return paid === null;
};

/**
 * The double that the member's NEXT payment would get, as of `at`. `perkId` is the perk to spend
 * when the reason is "perk"; it is internal and `publicDouble` strips it.
 */
export const pendingDouble = async (
  db: Db,
  memberId: string,
  at: Date
): Promise<DoublePoints & { perkId: string | null }> => {
  const referralPending = await isReferralPending(db, memberId);

  // Nothing to spend the perk on when the referral already doubles the visit, but the lookup
  // still reports the referral first, so the perk is only read when it can matter.
  return chooseDouble(
    referralPending,
    referralPending ? null : await waitingPerk(db, memberId, at)
  );
};

export const publicDouble = ({ applies, reason, until }: DoublePoints): DoublePoints => ({
  applies,
  reason,
  until
});

/**
 * How an ALREADY RECORDED visit was doubled, for a replay (a retried request). The first call
 * answers from the decision it took, never from here.
 *
 * The truth is what was actually credited, so the ledger row's own reason text is read first. A
 * perk shows on its row (`redeemedVisitId`). Only a visit whose credit was never written (a crash
 * between the visit and the credit) falls back to "is this the member's first earning payment",
 * which is the same rule the decision used.
 */
export const doubleOfVisit = async (
  db: Db,
  visit: { id: string; memberId: string; kind: VisitKind; amountCents: number }
): Promise<DoubleReason | null> => {
  if (visit.kind !== VisitKind.PAYMENT) return null;

  const perk = await db.memberReward.findFirst({
    where: {
      redeemedVisitId: visit.id,
      kind: MemberRewardKind.VENTAJA,
      detail: { path: ["perk"], equals: DOUBLE_PERK }
    },
    select: { id: true }
  });

  if (perk) return "perk";

  const credited = await db.pointsTransaction.findFirst({
    where: { memberId: visit.memberId, idempotencyKey: `visit:${visit.id}` },
    select: { reason: true }
  });

  if (credited) return credited.reason === REFERRAL_DOUBLE_REASON ? "referral" : null;

  if (!earnsProgress(visit.amountCents)) return null;

  const referral = await db.referral.findUnique({
    where: { referredId: visit.memberId },
    select: { id: true }
  });

  if (!referral) return null;

  const first = await db.paidVisit.findFirst({
    where: { memberId: visit.memberId, ...earningPayment },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true }
  });

  return first?.id === visit.id ? "referral" : null;
};
