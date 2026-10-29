import { CLINIC_TIME_ZONE, dayKeyIn, startOfYearIn } from "../../../common/utils/zoned-month";
import { CATEGORIES, P, TIERS } from "../engine.config";
import { rha } from "../engine.math";
import type { CategoryCode, TierCode } from "../engine.types";
import { RUNTIME_DECISIONS } from "./decisions";
import type { MilestoneView, ProgramView, TierView } from "./program-view";

/**
 * The rules that govern a programme once clients are using it.
 *
 * The engine only DESIGNS a programme. Everything here is what the guide's section 6 calls
 * "runtime rules the product must enforce": how a payment becomes progress, when a tier is
 * entered, what a purchase unlocks, when a reward lapses, what may be redeemed against what.
 *
 * All pure. Time is a parameter everywhere, never read from a clock, because the rules that
 * matter most here are the ones about dates — tenure, a 60-day expiry, a calendar-year
 * allowance — and a rule you cannot hand a date to is a rule you cannot test at its edges.
 */

/* --------------------------------------------------------------------------- tiers */

const strip = (value: string): string => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Reads a tier from what Member.tier stores.
 *
 * Member.tier holds the tier's display name — "Oro", not "oro" — because that is what a pass
 * shows and what the legacy scale stored. The engine keys everything on the lower-case code,
 * so this is the one place the two are reconciled. Null for a legacy tier name like "Gold",
 * which is how a member of a clinic that has not adopted a programme reads as having none.
 */
export const tierKeyOf = (stored: string | null | undefined): TierCode | null => {
  if (!stored) return null;

  const key = strip(stored.trim());

  return (TIERS as string[]).includes(key) ? (key as TierCode) : null;
};

/** Whole months from `since` to `now`, by Madrid calendar date, never negative. */
export const tenureMonths = (since: Date, now: Date): number => {
  const [y1, m1, d1] = dayKeyIn(CLINIC_TIME_ZONE, since).split("-").map(Number);
  const [y2, m2, d2] = dayKeyIn(CLINIC_TIME_ZONE, now).split("-").map(Number);
  const months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);

  return Math.max(0, months);
};

export interface TierInput {
  /** Progress euros earned. Never decreases, except on an explicit correction. */
  progress: number;
  tenureMonths: number;
  /** The tier the member holds now, if any. */
  current: TierCode | null;
  /** True only for a staff correction of a mistaken credit. */
  allowDemotion?: boolean;
}

export interface TierResolution {
  tier: TierView;
  /**
   * The tier whose progress threshold is already met but whose tenure is not. The guide's
   * rule: a client who reaches the threshold early "keeps earning rewards and enters the tier
   * when tenure is met" — so this is what the pass can honestly say they are waiting for.
   */
  waitingForTenure: TierView | null;
}

/**
 * The tier a member holds: the highest whose threshold AND minimum tenure are both met.
 *
 * Both gates, not either. Progress alone would let a member who spends heavily in a first
 * month reach Diamante; the guide requires 12, 24 and 36 months for Oro, Platino and
 * Diamante precisely so it cannot.
 *
 * Tiers are not lost. A member who held Oro stays at least at Oro however the maths would
 * otherwise read, because the guide says so — and because progress only rises, the only way
 * the computed tier could fall is a correction, which is the one case `allowDemotion` covers.
 */
export const resolveTier = (view: ProgramView, input: TierInput): TierResolution => {
  const meets = (t: TierView): boolean =>
    input.progress >= t.floor && input.tenureMonths >= t.minTenureMonths;

  let reached = 0;
  view.tiers.forEach((t, i) => {
    if (meets(t)) reached = i;
  });

  if (!input.allowDemotion && input.current) {
    const held = view.tiers.findIndex((t) => t.key === input.current);

    if (held > reached) reached = held;
  }

  const next = view.tiers[reached + 1];
  const waitingForTenure =
    next && input.progress >= next.floor && input.tenureMonths < next.minTenureMonths ? next : null;

  return { tier: view.tiers[reached], waitingForTenure };
};

/* ------------------------------------------------------------------------- progress */

export interface PurchaseLine {
  /** What was bought, by category. Absent means an ordinary treatment. */
  category?: CategoryCode;
  amountCents: number;
}

/**
 * The part of a purchase that earns progress.
 *
 * Pharmacological medicine and medical acts earn nothing, which is a legal constraint in
 * Spain rather than a product preference: the guide is explicit, and the counter at reception
 * is where it has to hold. A line with no category is an ordinary treatment.
 */
export const earningCents = (lines: PurchaseLine[]): number =>
  lines.reduce((sum, line) => {
    const earns = !line.category || CATEGORIES[line.category]?.points !== false;

    return earns ? sum + line.amountCents : sum;
  }, 0);

/** Treatment rather than retail, which is what a referral needs on a first payment. */
export const includesTreatment = (lines: PurchaseLine[]): boolean =>
  lines.length === 0 || lines.some((line) => line.category !== "COS");

export interface ProgressInput {
  /** Cents that earn progress. Use earningCents for a basket. */
  cents: number;
  /** The tier the member held WHEN THEY PAID — a later promotion does not backdate. */
  tier: TierView | null;
  /** A "double points" perk is waiting and this is a payment visit. */
  doubled?: boolean;
}

/**
 * Progress euros for one visit.
 *
 * One paid euro adds one progress euro times the multiplier of the tier held at the moment
 * of purchase (Oro 1.1, Platino 1.2, Diamante 1.3). Doubled by a waiting perk. Rounded once,
 * here, half away from zero: the ledger holds whole numbers, and rounding per visit bounds the
 * error at half a euro instead of letting it accumulate.
 */
export const purchaseProgress = ({ cents, tier, doubled = false }: ProgressInput): number =>
  rha((cents / 100) * (tier?.multiplier ?? 1) * (doubled ? 2 : 1));

/**
 * What one session of a prepaid package is worth, in cents.
 *
 * The guide: progress is added when each session is CONSUMED, the package price divided by its
 * number of sessions, never as a lump sum at purchase. Rounded to a whole cent; the package
 * price is the thing that was paid, so a session is allowed to be a cent off.
 */
export const bonoSessionCents = (packageCents: number, sessions: number): number => {
  if (!Number.isInteger(sessions) || sessions < 1) {
    throw new RangeError(`a package has at least one session, got ${sessions}`);
  }

  return Math.round(packageCents / sessions);
};

/* ----------------------------------------------------------------------- milestones */

/**
 * The milestones a visit crossed, in ladder order.
 *
 * Every one, not just the highest: "if one purchase crosses several thresholds, all of them
 * are issued." Entering a tier grants no gift, so tier milestones are not here. The interval is
 * open below and closed above — a member sitting exactly on a threshold has already been given
 * it — which is what makes the result a fact about one visit and not about the member's total.
 */
export const milestonesCrossed = (
  view: ProgramView,
  before: number,
  after: number
): MilestoneView[] => view.milestones.filter((m) => m.issue && m.th > before && m.th <= after);

/**
 * Which repeats of the recurring reward a visit crossed, as 1-based counts.
 *
 * After Diamante there are no more milestones, so one reward repeats every `every` progress
 * euros. Counted from the Diamante threshold (see RUNTIME_DECISIONS.recurringStartsAt): the
 * first lands `every` euros past it.
 */
export const recurringCrossed = (view: ProgramView, before: number, after: number): number[] => {
  const { every, startsAt } = view.recurring;

  if (after <= startsAt || every <= 0) return [];

  const upTo = Math.floor((after - startsAt) / every);
  const from = Math.floor(Math.max(0, before - startsAt) / every) + 1;
  const out: number[] = [];

  // Bounded: a single visit crossing dozens of repeats is a data error, not a windfall.
  for (let k = from; k <= upTo && out.length < 50; k += 1) out.push(k);

  return out;
};

export interface NextReward {
  title: string;
  /** Progress euros still to earn. Always at least 1. */
  remaining: number;
  /** How far through the CURRENT step, 0 to 100 — not through the whole tier. */
  percent: number;
  /** A ladder reward or perk, or the repeating one after Diamante. */
  source: "milestone" | "recurring";
}

/**
 * What the member is working towards next, for "PRÓXIMA RECOMPENSA" on their pass.
 *
 * The next milestone that actually issues something — a reward or a perk, not a tier-up,
 * which grants nothing — and how far through the step to it they are. Measured from the
 * previous milestone of ANY kind, so a member who has just entered a tier starts that step
 * at zero rather than appearing partway up it.
 *
 * Past the last milestone it is the repeating reward after Diamante. Null only for a
 * programme that has none, so the pass can leave the field out rather than show a bar that
 * means nothing.
 */
export const nextRewardFor = (view: ProgramView, progress: number): NextReward | null => {
  const next = view.milestones.find((m) => m.issue && m.th > progress);
  // The previous milestone of any kind, tier-ups included: a member who has just entered a
  // tier starts their next step at zero rather than appearing partway up it.
  const previous = Math.max(0, ...view.milestones.filter((m) => m.th <= progress).map((m) => m.th));
  const clamp = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));

  if (next?.issue) {
    const span = next.th - previous;

    return {
      title: next.issue.title,
      remaining: Math.max(1, next.th - progress),
      percent: span > 0 ? clamp(((progress - previous) / span) * 100) : 0,
      source: "milestone"
    };
  }

  const { every, startsAt, title } = view.recurring;

  if (every <= 0 || !title) return null;

  const done = Math.max(0, Math.floor((progress - startsAt) / every));
  const target = startsAt + (done + 1) * every;
  // Before the first repeat the step runs from the last milestone, which may sit below
  // Diamante's threshold when the final ladder reward comes before it.
  const from = Math.max(previous, startsAt + done * every);

  return {
    title,
    remaining: Math.max(1, target - progress),
    percent: clamp(((progress - from) / (target - from)) * 100),
    source: "recurring"
  };
};

/** When an issued reward lapses. */
export const rewardExpiry = (issuedAt: Date): Date =>
  new Date(issuedAt.getTime() + RUNTIME_DECISIONS.rewardTtlDays * 24 * 60 * 60 * 1000);

/* ------------------------------------------------------------------------ discount */

export interface DiscountInput {
  tier: TierView | null;
  /** Discounted products already bought in the current window. */
  usedThisWindow: number;
}

/**
 * How many more products can be bought at the tier's cosmetics discount.
 *
 * Zero for a tier with no discount (Bronce), otherwise the yearly limit minus what has been
 * used. The window is the calendar year in Madrid — see RUNTIME_DECISIONS.discountWindow.
 */
export const discountAllowance = ({ tier, usedThisWindow }: DiscountInput): number => {
  if (!tier || tier.discount <= 0) return 0;

  return Math.max(0, P.discountMaxProducts - usedThisWindow);
};

/** Where the current discount window began. */
export const discountWindowStart = (now: Date): Date => startOfYearIn(CLINIC_TIME_ZONE, now);

/* ------------------------------------------------------------------------ referral */

export interface ReferralReward {
  /** The unique key for issuing it: "ref:7". */
  sourceKey: string;
  title: string;
  /** Which of the five steps defines the reward. After ten this is always the tenth. */
  step: number;
}

/**
 * The reward due when a referrer's count reaches `count`, or null.
 *
 * Rewards sit at the 1st, 3rd, 5th, 7th and 10th. After the tenth, the tenth reward is issued
 * again every three more referrals — the 13th, 16th, 19th and so on.
 */
export const referralRewardAt = (view: ProgramView, count: number): ReferralReward | null => {
  const exact = view.referral.find((r) => r.n === count);

  if (exact) return { sourceKey: `ref:${count}`, title: exact.title, step: exact.n };

  const last = view.referral[view.referral.length - 1];
  const every = RUNTIME_DECISIONS.referralRepeatEvery;

  if (last && count > last.n && (count - last.n) % every === 0) {
    return { sourceKey: `ref:${count}`, title: last.title, step: last.n };
  }

  return null;
};

export interface Identity {
  id?: string;
  phone?: string | null;
  email?: string | null;
}

/**
 * True when two records are plausibly the same person.
 *
 * The guide asks to guard against self-referral and duplicate people by phone or email. The
 * comparison is deliberately exact on the canonical forms rather than fuzzy: a phone is already
 * stored as E.164, and a false positive here would deny a real referral its reward.
 */
export const sameIdentity = (a: Identity, b: Identity): boolean => {
  if (a.id && b.id && a.id === b.id) return true;
  if (a.phone && b.phone && a.phone === b.phone) return true;

  return Boolean(
    a.email && b.email && a.email.trim().toLowerCase() === b.email.trim().toLowerCase()
  );
};

/* ---------------------------------------------------------------------- redemption */

export type RedemptionRefusal =
  "ya_canjeado" | "caducado" | "sin_visita_de_pago" | "visita_ajena" | "visita_de_otro_dia";

export type RedemptionVerdict =
  { ok: true } | { ok: false; reason: RedemptionRefusal; message: string };

const REFUSALS: Record<RedemptionRefusal, string> = {
  ya_canjeado: "Este premio ya se canjeó.",
  caducado: "Este premio ha caducado: se puede usar durante 60 días desde que se consigue.",
  sin_visita_de_pago:
    "Solo se puede canjear en una visita con un pago o con una sesión de un bono ya pagado.",
  visita_ajena: "Esa visita no corresponde a este cliente.",
  visita_de_otro_dia: "Esa visita no es de hoy. Registra el pago de esta visita para canjear."
};

const refuse = (reason: RedemptionRefusal): RedemptionVerdict => ({
  ok: false,
  reason,
  message: REFUSALS[reason]
});

export interface RedemptionInput {
  reward: {
    clinicId: string;
    memberId: string;
    redeemedAt: Date | null;
    expiresAt: Date;
  };
  /** The visit the redemption is claimed against, or null when none was given or found. */
  visit: { clinicId: string; memberId: string; occurredAt: Date } | null;
  now: Date;
}

/**
 * May this reward be redeemed against this visit, now?
 *
 * The guide's rule is that a redemption needs "a visit that includes a payment or the
 * consumption of a prepaid session", enforced by the backend and not left as a staff
 * convention. So the question is answered from rows, not from a flag the caller asserts: a
 * redemption with no PaidVisit, a visit belonging to another member or centre, or one from
 * another day is refused.
 *
 * Checked in an order that reports the most useful reason first — already used, then expired,
 * then the visit problems — because a receptionist told "no visit" about an expired reward
 * would go looking for the wrong fix.
 */
export const checkRedemption = ({ reward, visit, now }: RedemptionInput): RedemptionVerdict => {
  if (reward.redeemedAt) return refuse("ya_canjeado");
  if (now.getTime() >= reward.expiresAt.getTime()) return refuse("caducado");
  if (!visit) return refuse("sin_visita_de_pago");

  if (visit.clinicId !== reward.clinicId || visit.memberId !== reward.memberId) {
    return refuse("visita_ajena");
  }

  if (dayKeyIn(CLINIC_TIME_ZONE, visit.occurredAt) !== dayKeyIn(CLINIC_TIME_ZONE, now)) {
    return refuse("visita_de_otro_dia");
  }

  return { ok: true };
};

/** A surprise must be redeemed against something from its own pool. */
export const isInSurprisePool = (
  pool: Array<{ id: string }> | undefined,
  itemId: string
): boolean => Boolean(pool?.some((item) => item.id === itemId));

/* ------------------------------------------------------------------ recalibration */

export interface RecalibrationInput {
  /** What the programme was designed around. */
  usedTicket: number;
  usedVisits: number;
  /** What the centre's real data shows. */
  measuredTicket: number;
  measuredVisits: number;
  daysOfData: number;
}

export interface RecalibrationAdvice {
  offer: boolean;
  ticketDrift: number;
  visitsDrift: number;
  /** Why not, when not. Spanish, for the screen that asks. */
  reason?: string;
}

const drift = (used: number, measured: number): number =>
  used > 0 ? Math.abs(measured - used) / used : 0;

/**
 * Whether the data is far enough from the assumptions to offer a recalibration.
 *
 * PROMPTED, never automatic (RUNTIME_DECISIONS.recalibration). This only answers "is it worth
 * asking"; changing a programme members are climbing is an act the centre chooses. Silent about
 * anything under 90 days of data, because a month of figures is not a pattern.
 */
export const recalibrationAdvice = (input: RecalibrationInput): RecalibrationAdvice => {
  const ticketDrift = drift(input.usedTicket, input.measuredTicket);
  const visitsDrift = drift(input.usedVisits, input.measuredVisits);

  if (input.daysOfData < RUNTIME_DECISIONS.recalibrationMinDays) {
    return {
      offer: false,
      ticketDrift,
      visitsDrift,
      reason: `Aún no hay datos suficientes: hacen falta ${RUNTIME_DECISIONS.recalibrationMinDays} días.`
    };
  }

  const over = Math.max(ticketDrift, visitsDrift) > RUNTIME_DECISIONS.recalibrationDrift;

  return {
    offer: over,
    ticketDrift,
    visitsDrift,
    reason: over ? undefined : "El ticket y la frecuencia reales encajan con el programa."
  };
};

/**
 * The "puntos dobles" perk. It is spent automatically by the next payment, so it can never be
 * redeemed by hand and a card must not offer it as a gift to present at the centre.
 */
export const isDoublePointsPerk = (kind: string, detail: unknown): boolean =>
  kind === "VENTAJA" &&
  typeof detail === "object" &&
  detail !== null &&
  (detail as { perk?: unknown }).perk === "doble";
