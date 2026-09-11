import { z } from "zod";

export const loyaltyTierSchema = z.enum(["gold", "diamond"]);

/**
 * Provider-independent loyalty pass data.
 *
 * Numbers stay numbers: Apple formats `numberStyle` and `currencyCode` fields on the device
 * in the member's own locale, which is strictly better than pre-formatting them server-side.
 */
export const loyaltyPassDataSchema = z
  .object({
    serialNumber: z.string().min(1).max(64),
    // Base32 is safe in every barcode encoding, and the code must never carry personal data
    // or a guessable member identifier.
    redemptionCode: z.string().regex(/^[A-Z2-7]{16,64}$/, "must be uppercase base32"),
    tier: loyaltyTierSchema,
    tierName: z.string().min(1).max(32),
    clinic: z.object({
      name: z.string().min(1).max(48),
      tagline: z.string().min(1).max(48)
    }),
    member: z.object({
      fullName: z.string().min(1).max(64),
      memberSince: z.string().regex(/^\d{4}$/, "must be a four digit year")
    }),
    balance: z.object({
      points: z.number().int().nonnegative(),
      creditCents: z.number().int().nonnegative(),
      currency: z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 currency code")
    }),
    reward: z.object({
      description: z.string().min(1).max(120),
      progressPercent: z.number().min(0).max(100)
    })
  })
  .refine((data) => data.redemptionCode !== data.serialNumber, {
    message: "redemptionCode must differ from serialNumber",
    path: ["redemptionCode"]
  });
