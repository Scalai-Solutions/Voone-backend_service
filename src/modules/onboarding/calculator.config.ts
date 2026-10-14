/**
 * The five-year calculator's assumptions.
 *
 * Kept apart from the engine's config on purpose: the engine decides a programme and is
 * compared against the partners' reference line by line, while these are the founders' own
 * estimates for what a programme brings in. They are not measured, and the feedback says they
 * will be recalibrated after the first pilots — so each is a named value here, never a number
 * written into the model, and changing one touches nothing about how a programme is chosen.
 */
export const CALC = {
  /** Share of joiners who would be repeaters without a programme. */
  repeatShare: 0.42,
  /** Extra share who repeat because of it. Repeaters with a programme: 0.42 + 0.10. */
  uplift: 0.1,
  /** Visits a year by an occasional client. */
  occVisits: 1.3,
  /** Share of repeaters still active a year later. */
  repeatRetention: 0.75,
  /** Share of occasional clients still active a year later. */
  occRetention: 0.5,
  /** Occasional clients take up this share of a tier's standing benefits. */
  occBenefitShare: 0.3,
  /** Share of issued rewards and perks that are actually redeemed. */
  redemption: 0.75,
  /** Repeaters spend this much more per visit under a programme. */
  spendUplift: 0.05,
  /** Share of redemptions that bring a paid visit which would not have happened. */
  redeemVisitShare: 0.1,
  /** New clients a year brought by referrals, as a share of the average membership. */
  refShare: 0.05,
  /** What a tier's yearly event costs the centre per client who attends, and how many attend. */
  eventCost: 6,
  eventAttendance: 0.5,
  testCost: 1,
  cosmeticShareOfSpend: 0.05,
  /** What Voone charges a centre a month, by the kind of centre. */
  feeBySegment: { low: 49.99, mid: 99.99, high: 149.99 },
  /** Share of the "clients a year" answer who are expected to join the programme. */
  adhesion: 0.5,
  years: 5,
  clients: { min: 10, max: 5000 },
  ticket: { min: 10, max: 1000 }
} as const;

/** The sixth question's buckets, as the number of active clients a year they stand for. */
export const MEMBER_BUCKETS: Record<string, number> = { m1: 100, m2: 275, m3: 600, m4: 1000 };
