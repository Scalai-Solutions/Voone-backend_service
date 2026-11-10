import { MemberRewardKind, VisitKind, type Prisma } from "@prisma/client";

/**
 * Who earns double on a payment visit, decided in ONE place.
 *
 * The visit credit (VisitService) and the answer the reception screen shows before the visit
 * (GET .../rewards -> `doublePoints`) both call `pendingDouble`, so the screen and the credit can
 * never disagree about whether a visit will be doubled.
 *
 * One thing doubles a visit, and it is x2 IN TOTAL, never x4: a waiting `doble` perk (a tier
 * milestone's gift), spent by the next payment.
 *
 * A referred client's first visit is NOT doubled any more. It used to be; a client referred by a
 * friend now starts with their welcome progress and that is all. Visits already credited under the
 * old rule keep their ledger reason (REFERRAL_DOUBLE_REASON), which is why a replay of one still
 * reads as "referral" below.
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

/**
 * The reason the ledger row of a visit doubled under the old referral rule carries. Nothing writes
 * it any more; it is kept so a replay of such a visit still answers as it was credited.
 */
export const REFERRAL_DOUBLE_REASON = "Visita de pago (doble por recomendación)";

type Db = Pick<Prisma.TransactionClient, "memberReward" | "pointsTransaction">;

/**
 * The decision itself, from the one fact it depends on. Pure, so the visit credit, the rewards
 * lookup and the wallet card all go through it: a waiting perk doubles the visit.
 */
export const chooseDouble = (
  perk: { id: string; expiresAt: Date } | null
): DoublePoints & { perkId: string | null } => {
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
 * The double that the member's NEXT payment would get, as of `at`. `perkId` is the perk to spend
 * when the reason is "perk"; it is internal and `publicDouble` strips it.
 */
export const pendingDouble = async (
  db: Db,
  memberId: string,
  at: Date
): Promise<DoublePoints & { perkId: string | null }> => {
  return chooseDouble(await waitingPerk(db, memberId, at));
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
 * perk shows on its row (`redeemedVisitId`). A visit doubled under the old referral rule shows by
 * its ledger reason.
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

  return null;
};
