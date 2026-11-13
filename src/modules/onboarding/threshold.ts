import { realThresholds } from "./engine";
import { P, TIER_BENEFITS, TIERS } from "./engine.config";
import type { Milestone, Program } from "./engine.types";
import { retotal, type SwapResult } from "./swap";

/**
 * Moving the spend at which a reward or a perk unlocks.
 *
 * The admin reads and types what a client has actually PAID (the screen's "El cliente ha gastado"),
 * whereas a milestone stores PROGRESS euros (`th`), which run faster than paid euros from Oro up.
 * So the typed amount is turned into progress with the multiplier of the reward's own tier band,
 * rounded to a whole euro as the ledger holds them. The milestone must stay strictly between the
 * milestones either side of it, so tier bands, the order of the ladder and every other row's spend
 * are untouched: the step before and the step after a reward or perk are earned in the same band,
 * at the same multiplier, so moving it only moves its own row. A tier step never moves: it is
 * where the tier itself begins.
 *
 * Pure: it takes a programme and returns a new one, never the same object.
 */

const fail = (reason: string): SwapResult => ({ ok: false, reason });

const euros = (n: number): string => `${n.toLocaleString("es-ES")} €`;

export const THRESHOLD_REFUSALS = {
  notReward: "No existe ese hito.",
  notWhole: "El gasto tiene que ser un número entero de euros, mayor que 0.",
  noRoom: "No hay margen para mover esta fila: los hitos de al lado están demasiado cerca."
} as const;

export interface Geometry {
  /** The progress threshold the typed amount `real` would store. */
  thAt: (real: number) => number;
  /** The whole euros the admin may type, both ends included; null when there is no room. */
  range: { min: number; max: number } | null;
}

/**
 * The spends a milestone in band `tramo` may sit at, strictly between `prev` and `next` (either
 * may be absent: the ladder's start, or no step after). Also how an insert into a band is priced.
 */
export const geometryBetween = (
  program: Program,
  prev: Milestone | undefined,
  next: Milestone | undefined,
  tramo: number
): Geometry => {
  const prevTh = prev?.th ?? 0;
  const prevReal = prev ? program.realTh[prev.n] : 0;
  const mult = TIER_BENEFITS[TIERS[tramo - 1]].mult;
  const thAt = (real: number): number => Math.round(prevTh + (real - prevReal) * mult);

  if (!next) return { thAt, range: null };

  // The thresholds rise with the typed amount, so the range is found from its two ends; each loop
  // steps once or twice at most.
  let min = Math.max(1, Math.ceil(prevReal));

  while (thAt(min) <= prevTh) min += 1;

  let max = Math.floor(program.realTh[next.n]);

  while (max >= min && thAt(max) >= next.th) max -= 1;

  return { thAt, range: max >= min ? { min, max } : null };
};

const multOf = (tramo: number): number => TIER_BENEFITS[TIERS[tramo - 1]].mult;

// A reward or perk always sits before a tier step: the ladder ends at Diamante's.
const geometryOf = (program: Program, at: number): Geometry =>
  geometryBetween(
    program,
    program.lad.ms[at - 1],
    program.lad.ms[at + 1],
    program.lad.ms[at].tramo
  );

/**
 * Tier step `at` at `real` euros paid: its threshold, and the progress every row after it shifts by
 * so each keeps its spend. Null when the step would not stay strictly between its neighbours.
 */
const placeStep = (
  program: Program,
  at: number,
  real: number
): { th: number; shift: number } | null => {
  const { ms } = program.lad;
  const prev = ms[at - 1];
  const next = ms[at + 1];
  const prevTh = prev?.th ?? 0;
  const prevReal = prev ? program.realTh[prev.n] : 0;
  const th = geometryBetween(program, prev, undefined, ms[at].tramo).thAt(real);

  if (th <= prevTh) return null;
  if (!next) return { th, shift: 0 };

  // What `th` really stands for once rounded to whole progress euros.
  const reached = prevReal + (th - prevTh) / multOf(ms[at].tramo);
  const shift = Math.round(th + (program.realTh[next.n] - reached) * multOf(next.tramo)) - next.th;

  return next.th + shift > th ? { th, shift } : null;
};

/** The whole euros a tier step may be moved to, both ends included; null when there is no room. */
const stepRange = (program: Program, at: number): { min: number; max: number } | null => {
  const { ms } = program.lad;
  const prev = ms[at - 1];
  const next = ms[at + 1];
  const { thAt } = geometryBetween(program, prev, undefined, ms[at].tramo);
  let min = Math.max(1, Math.ceil(prev ? program.realTh[prev.n] : 0));

  while (thAt(min) <= (prev?.th ?? 0)) min += 1;

  // Diamante's step has nothing after it. Its ceiling is a typo guard: twice the longest the
  // engine lets a client take to reach Diamante, and never below where it is now.
  let max = next
    ? Math.floor(program.realTh[next.n])
    : Math.max(Math.floor(2 * P.maxYears * program.est.A), Math.round(program.realTh[ms[at].n]));

  // Each loop steps once or twice at most, as in `geometryBetween`.
  while (max >= min && !placeStep(program, at, max)) max -= 1;

  return max >= min ? { min, max } : null;
};

const rangeAt = (program: Program, at: number): { min: number; max: number } | null =>
  program.lad.ms[at].type === "nivel" ? stepRange(program, at) : geometryOf(program, at).range;

/** The whole euros of spend a milestone may be moved to, or null when it has no room. */
export const spendRange = (program: Program, n: number): { min: number; max: number } | null => {
  const at = program.lad.ms.findIndex((m) => m.n === n);

  return at < 0 ? null : rangeAt(program, at);
};

export const moveMilestone = (program: Program, n: number, realSpend: number): SwapResult => {
  const at = program.lad.ms.findIndex((m) => m.n === n);

  if (at < 0) return fail(THRESHOLD_REFUSALS.notReward);
  if (!Number.isInteger(realSpend) || realSpend < 1) return fail(THRESHOLD_REFUSALS.notWhole);

  const range = rangeAt(program, at);

  if (!range) return fail(THRESHOLD_REFUSALS.noRoom);

  if (realSpend < range.min || realSpend > range.max) {
    return fail(`El gasto tiene que estar entre ${euros(range.min)} y ${euros(range.max)}.`);
  }

  const next = structuredClone(program);

  if (program.lad.ms[at].type === "nivel") {
    // In range, so it places.
    const { th, shift } = placeStep(program, at, realSpend)!;

    next.lad.ms[at].th = th;
    for (const m of next.lad.ms.slice(at + 1)) m.th += shift;
  } else {
    next.lad.ms[at].th = geometryOf(program, at).thAt(realSpend);
  }

  // A reward keeps its own copy of the milestone, and the ladder its last step; neither may disagree.
  const thOf = new Map(next.lad.ms.map((m) => [m.n, m.th]));

  for (const c of next.chosen) c.m.th = thOf.get(c.m.n) ?? c.m.th;
  next.lad.last.th = thOf.get(next.lad.last.n) ?? next.lad.last.th;

  next.realTh = realThresholds(next.lad.ms);
  next.diamondReal = next.realTh[next.lad.last.n];

  return { ok: true, program: retotal(next) };
};

/**
 * Sets how often the reward after Diamante comes round, as whole euros PAID (what the admin reads:
 * "Por cada X € que gasta el cliente"). `rec.every` stores PROGRESS, which runs at Diamante's
 * multiplier, so the typed amount is stored ×mult; presentation divides it back, and for a whole
 * number of euros the round trip returns exactly what was typed.
 */
export const setRecurringEvery = (program: Program, realSpend: number): SwapResult => {
  if (!Number.isInteger(realSpend) || realSpend < 1) return fail(THRESHOLD_REFUSALS.notWhole);

  const next = structuredClone(program);

  next.rec.every = Math.round(realSpend * TIER_BENEFITS.diamante.mult);

  return { ok: true, program: retotal(next) };
};
