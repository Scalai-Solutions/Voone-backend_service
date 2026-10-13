import { P } from "../engine.config";

/**
 * Every place the implementation guide left a rule open, and the answer this code gives.
 *
 * Collected in one file on purpose. These are product decisions that were made provisionally
 * so that building could continue, and the people who own them — Sergio, the partners —
 * need to be able to find each one, read the reasoning and change it without searching the
 * codebase. docs/onboarding-decisions.md is the narrative; this is the switchboard.
 *
 * Where a choice is a plain value it lives here and the rest of the code reads it. Where it
 * is a rule with consequences, the comment says which test pins it.
 */
export const RUNTIME_DECISIONS = {
  /**
   * Where a member's tenure starts. The guide's reference assumes sign-up; the open question
   * is whether it should be pass download or the first paid visit.
   *
   * Sign-up, because it is the only date we hold for every member, and because the other two
   * would let a member's tier depend on something the centre cannot see or verify. Changing it
   * means changing what `tenureStart` returns, nothing else.
   */
  tenureStartsAt: "signup" as const,

  /**
   * The window the "3 products a year" cosmetics allowance resets over. The guide assumes a
   * calendar year; the open question is whether it should be 12 months from tier entry.
   *
   * Calendar year in Madrid. It is the reading the guide's own section 6 assumes, it is the one
   * a receptionist can apply without a calculator, and a rolling window needs a per-member
   * anniversary that does not exist yet.
   */
  discountWindow: "calendar_year" as const,

  /**
   * How long an issued reward or perk lasts. Not an open question — the guide states it — but
   * named here because several rules and tests depend on it and a bare 60 reads as a typo.
   */
  rewardTtlDays: 60,

  /**
   * Which visit a "double points" perk doubles.
   *
   * The guide says it doubles "the next single paid visit, then is consumed". "Single" is
   * read as opposed to a prepaid-package session: the perk waits for the next visit in which
   * money changes hands, and a package session in between does not use it up. The alternative
   * reading would let a perk be wasted on a session whose progress was fixed when the package
   * was bought.
   */
  doublePointsAppliesTo: "next_payment" as const,

  /**
   * When the recurring reward after Diamante is first issued.
   *
   * The guide says one reward repeats "every N progress euros" once the client is Diamante, and
   * does not say from where. Counted from the Diamante threshold: the first is issued N euros
   * past it, the second 2N, and so on. Starting at the threshold itself would hand a reward to
   * everyone on the day they reach the top tier, on top of entering it.
   */
  recurringStartsAt: "diamante_threshold" as const,

  /**
   * Progress is stored in whole euros, rounded per visit, half away from zero.
   *
   * The ledger holds integers (a database CHECK enforces it) and a tier multiplier of 1.1 on a
   * 65 euro visit gives 71.5. Rounding once per visit bounds the error at half a euro and keeps
   * it from compounding across a member's history.
   */
  progressRounding: "per_visit_half_away_from_zero" as const,

  /**
   * Whether a client can lose a tier. The guide says tiers are not lost in the current design.
   * An explicit staff CORRECTION of a mistaken credit is the one exception, so that a wrong
   * million-point entry can be undone for tier as well as for balance — see PointsService.
   */
  demotion: "only_on_staff_correction" as const,

  /**
   * Who chooses the item for a surprise reward.
   *
   * Staff pick from the pool at redemption and the choice is stored. The stricter reading of
   * two the guide allows; free text can be added later, but a free-text history cannot be
   * turned into a pool selection afterwards.
   */
  surpriseChosenBy: "staff_from_pool" as const,

  /**
   * Progress and rewards are per centre. The guide notes the engine designs one programme per
   * centre and leaves open whether a group of centres should share progress.
   *
   * A Member row belongs to exactly one clinic, so this is not a flag we could flip: sharing
   * progress would mean a different identity model, and is a decision to make with a real
   * multi-centre customer rather than in advance of one.
   */
  progressScope: "per_centre" as const,

  /**
   * How a payment reaches Voone. The guide's open question: staff entry, a QR scan at the
   * till, or an integration with the centre's management software.
   *
   * Staff entry first, because it needs nothing from the centre and the existing reception
   * screen already does it. The data model does not assume it: PaidVisit.source records the
   * channel, and the redemption rule depends only on a visit existing.
   */
  acceptedVisitSources: ["STAFF_ENTRY"] as const,

  /**
   * Drift between the ticket and frequency the programme was built on and what the centre
   * actually does, beyond which a recalibration is worth offering. 15 percent, the figure the
   * guide's earlier specification gives and the later guide leaves unchanged.
   */
  recalibrationDrift: 0.15,

  /** A recalibration needs enough history to mean something: about 90 days. */
  recalibrationMinDays: 90,

  /**
   * Recalibration is PROMPTED, never automatic. The programme is something members are working
   * towards, so changing it is an act the centre must choose, not a thing that happens to them.
   * The check only says whether to offer; creating the draft is an explicit request.
   */
  recalibration: "prompted" as const,

  /**
   * A public review must never earn progress, a reward or any benefit, and the product must not
   * ask only satisfied clients — both are against Google's policy.
   *
   * There is deliberately no code path for this to be implemented in: progress can only come
   * from a PaidVisit, and no source of one is a review. If a private satisfaction survey is
   * ever rewarded, that is a different feature with its own source, and the guide's open
   * question about which one "leave a rating" means must be answered first.
   */
  reviewsEarnProgress: false as const,

  /** Redemption window references, kept with the rest so a recalibration reads one file. */
  referralRepeatEvery: P.refRepeatEvery
} as const;

export type RuntimeDecisions = typeof RUNTIME_DECISIONS;
