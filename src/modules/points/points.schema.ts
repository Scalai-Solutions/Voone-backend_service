import { PointsTransactionKind } from "@prisma/client";
import { z } from "zod";

/**
 * A positive whole number of points, bounded.
 *
 * The upper bound is not ceremony. Manual adjustment (VOO-65) lets a staff member type a
 * number, and a slipped keyboard turning 100 into 100000000 would push someone to the top
 * tier instantly. It is recoverable — clawBack reduces lifetime too — but it is far
 * cheaper to refuse.
 */
const pointsAmount = z
  .number()
  .int("points must be a whole number")
  .positive("points must be greater than zero")
  .max(1_000_000, "points must be at most 1,000,000 in a single movement");

/**
 * Supplied by the caller, not generated here.
 *
 * That is the entire point: the key must be stable across retries of the SAME operation,
 * so it has to come from whatever identifies that operation upstream — a scan id, a till
 * reference. A key minted server-side would be different on every retry and would
 * guarantee double-crediting rather than prevent it.
 */
const idempotencyKey = z.string().min(8, "idempotencyKey must be at least 8 characters").max(128);

const reason = z.string().trim().min(1).max(200).optional();
const sourceRef = z.string().trim().min(1).max(200).optional();

export const creditSchema = z.object({
  points: pointsAmount,
  // REDEEM and EXPIRY are deliberately absent: a redemption goes through the redeem
  // endpoint, which checks affordability, and expiry is not a thing staff do by hand.
  kind: z
    .enum([
      PointsTransactionKind.EARN,
      PointsTransactionKind.REFERRAL,
      PointsTransactionKind.ADJUSTMENT
    ])
    .default(PointsTransactionKind.EARN),
  reason,
  sourceRef,
  idempotencyKey
});

export const redeemSchema = z.object({
  points: pointsAmount,
  reason,
  sourceRef,
  idempotencyKey
});

export const clawBackSchema = z.object({
  points: pointsAmount,
  /** Required here, unlike the others: taking points back always needs a why. */
  reason: z.string().trim().min(1).max(200),
  sourceRef,
  idempotencyKey
});

export type CreditInput = z.infer<typeof creditSchema>;
export type RedeemInput = z.infer<typeof redeemSchema>;
export type ClawBackInput = z.infer<typeof clawBackSchema>;
