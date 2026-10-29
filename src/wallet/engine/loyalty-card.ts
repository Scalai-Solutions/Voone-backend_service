import { z } from "zod";

import { CARD_TEXT_MAX_LENGTH } from "./card-text";

/**
 * The loyalty card as the domain understands it, with nothing provider-specific in it.
 *
 * This is the single shape every wallet provider consumes: the Apple adapter renders it
 * into a signed .pkpass, the Google adapter maps it onto a loyalty object. Neither Apple
 * nor Google types appear here, and nothing in this file may import one — that constraint
 * is the whole point, because it is what lets the two providers be developed in parallel
 * without either editing the other's code.
 *
 * Assembled in one place from Member + ClinicTemplate + the points ledger, so the two
 * providers can never disagree about what a member's card says.
 */

/** #rgb or #rrggbb, matching what ClinicTemplate.hexBackgroundColor holds. */
export const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "must be a hex colour such as #ead0bd");

/** Exactly MEMBER_CODE_ALPHABET: no I, L, O, 0 or 1, because it gets read aloud. */
export const MEMBER_CODE_PATTERN = /^[A-HJ-KM-NP-Z2-9]{5}$/;

/**
 * Appearance and copy for one clinic's programme, mirroring ClinicTemplate.
 *
 * Card appearance is per clinic template, not per tier: a clinic chooses its own
 * background colour and field labels, and the card follows whatever it chose.
 */
export const cardTemplateSchema = z.object({
  programName: z.string().min(1).max(48),
  backgroundColor: hexColorSchema,
  logoUrl: z.string().url().max(2048).optional(),
  logoOnDarkUrl: z.string().url().max(2048).optional(),
  heroImageUrl: z.string().url().max(2048).optional(),
  websiteUrl: z.string().url().max(2048).optional(),
  appointmentUrl: z.string().url().max(2048).optional(),
  appLinkText: z.string().min(1).max(30).optional(),
  appLinkDescription: z.string().min(1).max(120).optional(),
  pointsLabel: z.string().min(1).max(32),
  tierLabel: z.string().min(1).max(32),
  benefitsText: z.string().min(1).max(CARD_TEXT_MAX_LENGTH).optional(),
  infoText: z.string().min(1).max(CARD_TEXT_MAX_LENGTH).optional()
});

/**
 * A member's loyalty card.
 *
 * Numbers stay numbers: Apple formats numberStyle and currencyCode fields on the device in
 * the member's own locale, which beats pre-formatting them server-side. Google's loyalty
 * object takes a numeric balance for the same reason.
 */
export const loyaltyCardSchema = z
  .object({
    /**
     * Member.id. Ours, never a provider's, and never rendered onto the card — it is here
     * because a card belongs to someone, and WalletObject is keyed by [memberId,
     * provider]. Without it a provider could build a card it cannot then record.
     */
    memberId: z.string().min(1).max(64),

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
      /**
       * The number the member reads off their own card, and reads aloud at reception.
       *
       * Deliberately separate from serialNumber, which is a key rather than a number a
       * person uses: Apple identifies an installed pass by (passTypeIdentifier,
       * serialNumber), so that one is derived from Member.id and can never be shortened
       * without orphaning passes already on members' phones.
       *
       * Optional because members who signed up before Member.code existed have none
       * until the backfill reaches them, and a card is still perfectly usable without it.
       */
      // Exactly MEMBER_CODE_ALPHABET: no I, L, O, 0 or 1, because it gets read aloud.
      // Spelled as a range rather than imported so this file keeps its rule that nothing
      // provider- or infrastructure-specific reaches the domain shape.
      code: z
        .string()
        .regex(MEMBER_CODE_PATTERN, "must be five unambiguous uppercase characters")
        .optional(),
      // Member stores only createdAt, so the year is derived and may be absent.
      memberSince: z
        .string()
        .regex(/^\d{4}$/, "must be a four digit year")
        .optional()
    }),

    // Member.pointsBalance today; the points ledger once it exists.
    points: z.number().int().nonnegative(),

    // No column backs either of these yet, so both are omitted from the card rather than
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
        progressPercent: z.number().min(0).max(100),
        /** The reward's own name and the points still to earn, where the source knows them apart. */
        title: z.string().min(1).max(120).optional(),
        remainingPoints: z.number().int().nonnegative().optional()
      })
      .optional(),

    /**
     * The clinic's latest message to this member, already formatted for display. Only the
     * Apple card renders it (Google has its own message API and ignores this).
     */
    message: z.object({ text: z.string().min(1).max(300) }).optional(),

    /**
     * The rewards this member has earned and can redeem at the clinic right now. Present (and
     * possibly empty) for a clinic on an onboarding programme, absent for every other clinic.
     * `expiresAt` is an ISO instant: it is stored, never derived from the clock, so two builds
     * of an unchanged member stay byte-equal.
     */
    rewards: z
      .object({
        available: z
          .array(
            z.object({
              title: z.string().min(1).max(120),
              expiresAt: z.string().datetime()
            })
          )
          .max(20)
      })
      .optional(),

    /**
     * A x2 waiting for the member's next visit, for a clinic on a programme: a double-points perk
     * (`until` is its stored expiry) or a referred member who has not paid yet (no end date). It
     * comes from the same decision the visit credit takes, so the card never promises what the
     * credit will not do. Absent when nothing is waiting.
     */
    boost: z
      .object({
        kind: z.enum(["perk", "referral"]),
        until: z.string().datetime().optional()
      })
      .optional(),

    /**
     * What the member shares to recommend the clinic, for a clinic on a programme: their own member
     * code and the public sign-up link that carries it (`<base>/alta/<clinic>?ref=<code>`). Absent
     * when any part of the link is unknown, rather than a card with a broken link on it.
     */
    referral: z
      .object({
        code: z
          .string()
          .regex(MEMBER_CODE_PATTERN, "must be five unambiguous uppercase characters"),
        url: z.string().url().max(2048)
      })
      .optional(),

    /**
     * The benefits of the member's CURRENT tier as the clinic's live onboarding programme defines
     * them: the single source of truth, which replaces the hand-typed `template.benefitsText` on the
     * pass. Absent for a clinic with no live programme, and when the tier has none, so the pass then
     * falls back to `benefitsText`. The lines are already fitted so the rendered text stays within
     * 500 characters; a last "… y N más" line says how many were left out.
     */
    tierBenefits: z
      .object({
        tier: z.string().min(1).max(40),
        lines: z.array(z.string().min(1).max(120)).min(1).max(12)
      })
      .optional(),

    template: cardTemplateSchema
  })
  .refine((data) => data.redemptionCode !== data.serialNumber, {
    message: "redemptionCode must differ from serialNumber",
    path: ["redemptionCode"]
  });

export type CardTemplate = z.infer<typeof cardTemplateSchema>;

export type LoyaltyCard = z.infer<typeof loyaltyCardSchema>;
