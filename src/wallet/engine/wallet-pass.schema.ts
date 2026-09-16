import { z } from "zod";

/** #rgb or #rrggbb, matching what ClinicTemplate.hexBackgroundColor holds. */
export const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "must be a hex colour such as #ead0bd");

/**
 * Appearance and copy for one clinic's programme, mirroring ClinicTemplate.
 *
 * Pass appearance is per clinic template, not per tier: a clinic chooses its own
 * background colour and field labels, and the pass follows whatever it chose.
 */
export const passTemplateSchema = z.object({
  programName: z.string().min(1).max(48),
  backgroundColor: hexColorSchema,
  pointsLabel: z.string().min(1).max(32),
  tierLabel: z.string().min(1).max(32),
  benefitsText: z.string().min(1).max(500).optional(),
  infoText: z.string().min(1).max(500).optional()
});

/**
 * Provider-independent loyalty pass data.
 *
 * Numbers stay numbers: Apple formats numberStyle and currencyCode fields on the device in
 * the member's own locale, which beats pre-formatting them server-side.
 */
export const loyaltyPassDataSchema = z
  .object({
    serialNumber: z.string().min(1).max(64),
    // Base32 is safe in every barcode encoding, and the code must never carry personal data
    // or a guessable member identifier.
    redemptionCode: z.string().regex(/^[A-Z2-7]{16,64}$/, "must be uppercase base32"),

    // Free text, and optional: Member.tier is a nullable string in the authoritative
    // schema rather than an enum, so no fixed set of tiers can be assumed here.
    tier: z.string().min(1).max(32).optional(),

    clinic: z.object({ name: z.string().min(1).max(48) }),

    member: z.object({
      fullName: z.string().min(1).max(64),
      // Member stores only createdAt, so the year is derived and may be absent.
      memberSince: z
        .string()
        .regex(/^\d{4}$/, "must be a four digit year")
        .optional()
    }),

    // Member.pointsBalance.
    points: z.number().int().nonnegative(),

    // No column backs either of these yet, so both are omitted from the pass rather than
    // invented. A card a member reads as real should not carry made-up figures.
    credit: z
      .object({
        cents: z.number().int().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 currency code")
      })
      .optional(),
    reward: z
      .object({
        description: z.string().min(1).max(120),
        progressPercent: z.number().min(0).max(100)
      })
      .optional(),

    template: passTemplateSchema
  })
  .refine((data) => data.redemptionCode !== data.serialNumber, {
    message: "redemptionCode must differ from serialNumber",
    path: ["redemptionCode"]
  });
