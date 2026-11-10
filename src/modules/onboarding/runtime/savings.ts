import { MemberRewardKind, MemberSavingKind, Prisma } from "@prisma/client";

/**
 * What the programme has saved a member, in cents.
 *
 * A saving is a row (MemberSaving), written in the same transaction as what caused it and keyed so
 * a retry cannot count it twice; `Member.savingsCents` is their cached sum, which the card reads.
 * Only three things save a member money: a gift redeemed (at its retail value), a perk the centre
 * has valued, and the tier's discount on cosmetics. The double-points perk never counts: it is
 * points, not money. Corrections are negative ADJUSTMENT rows, never edits.
 */

type Db = Prisma.TransactionClient;

/** The perks a centre may put a value on. "doble" is deliberately absent. */
export const PERK_VALUE_KEYS = ["diag", "mejora", "sorpresa"] as const;

export type PerkValueKey = (typeof PERK_VALUE_KEYS)[number];

/** Cents per perk. A perk with no entry is worth nothing to the total. */
export type PerkValues = Partial<Record<PerkValueKey, number>>;

/** Ten thousand euros: a typo guard, since this number is printed on a member's card. */
export const MAX_SAVING_CENTS = 1_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a clinic row's `perkValues` says, ignoring anything that is not a positive whole number of cents. */
export const parsePerkValues = (raw: unknown): PerkValues => {
  if (!isRecord(raw)) return {};

  const values: PerkValues = {};

  for (const key of PERK_VALUE_KEYS) {
    const cents = raw[key];

    if (typeof cents === "number" && Number.isInteger(cents) && cents > 0) {
      values[key] = Math.min(cents, MAX_SAVING_CENTS);
    }
  }

  return values;
};

export interface GiftSaving {
  kind: MemberSavingKind;
  cents: number;
}

/**
 * What redeeming this reward saved the member, or null when it saved nothing on record.
 *
 * A ladder, recurring or referral reward counts the retail value stored on it when it was issued
 * (euros, as `Candidate.value`), so a later change to the price sheet cannot move what a member
 * already saved. A reward issued before that value was stored counts nothing, rather than a guess.
 * A perk counts what the centre has set for its kind, and the double-points perk never counts.
 */
export const giftSaving = (
  kind: MemberRewardKind,
  detail: unknown,
  perkValues: PerkValues
): GiftSaving | null => {
  const body = isRecord(detail) ? detail : {};

  if (kind === MemberRewardKind.VENTAJA) {
    const perk = body.perk;

    if (typeof perk !== "string" || !(PERK_VALUE_KEYS as readonly string[]).includes(perk)) {
      return null;
    }

    const cents = perkValues[perk as PerkValueKey];

    return cents ? { kind: MemberSavingKind.PERK, cents } : null;
  }

  const euros = body.value;

  if (typeof euros !== "number" || !Number.isFinite(euros) || euros <= 0) return null;

  const cents = Math.min(Math.round(euros * 100), MAX_SAVING_CENTS);

  return cents > 0 ? { kind: MemberSavingKind.GIFT, cents } : null;
};

/**
 * The discount a visit gave: the list price of the cosmetics bought at the tier's discount, times
 * that discount. Never more than the list price. Zero when reception gave no price or the tier has
 * no discount.
 */
export const discountSaving = (listCents: number, rate: number): number => {
  if (!Number.isFinite(listCents) || listCents <= 0 || !(rate > 0)) return 0;

  return Math.min(listCents, Math.round(listCents * Math.min(rate, 1)));
};

export interface SavingInput {
  clinicId: string;
  memberId: string;
  kind: MemberSavingKind;
  cents: number;
  sourceKey: string;
  discountRate?: number;
  reason?: string;
  createdBy?: string;
}

/**
 * Appends a saving and moves the member's cached total by the same amount, in the caller's
 * transaction. Returns false, touching nothing, when this saving was already recorded: the
 * `(memberId, sourceKey)` key is what makes a retried redemption or visit safe.
 */
export const recordSaving = async (db: Db, input: SavingInput): Promise<boolean> => {
  if (!Number.isInteger(input.cents) || input.cents === 0) return false;

  const created = await db.memberSaving.createMany({
    data: [
      {
        clinicId: input.clinicId,
        memberId: input.memberId,
        kind: input.kind,
        cents: input.cents,
        sourceKey: input.sourceKey,
        discountRate: input.discountRate,
        reason: input.reason,
        createdBy: input.createdBy
      }
    ],
    skipDuplicates: true
  });

  if (created.count === 0) return false;

  await db.member.update({
    where: { id: input.memberId },
    data: { savingsCents: { increment: input.cents } }
  });

  return true;
};

/**
 * Sets a member's cached total from the sum of their rows, so it cannot drift. Used by the backfill,
 * which sets rather than increments: running it twice gives the same number.
 */
export const syncSavingsCache = async (db: Db, memberId: string): Promise<number> => {
  const sum = await db.memberSaving.aggregate({ where: { memberId }, _sum: { cents: true } });
  const total = Math.max(0, sum._sum.cents ?? 0);

  await db.member.update({ where: { id: memberId }, data: { savingsCents: total } });

  return total;
};
