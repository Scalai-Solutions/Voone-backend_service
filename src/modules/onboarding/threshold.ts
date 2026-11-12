import { realThresholds } from "./engine";
import { TIER_BENEFITS, TIERS } from "./engine.config";
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
  notReward: "Solo se puede cambiar el gasto de un premio o de una ventaja.",
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

// The ladder always ends at Diamante's tier step, so a reward or perk always has one after it.
const geometryOf = (program: Program, at: number): Geometry =>
  geometryBetween(
    program,
    program.lad.ms[at - 1],
    program.lad.ms[at + 1],
    program.lad.ms[at].tramo
  );

/** A reward or a perk may move; a tier step may not. */
const movable = (type: string): boolean => type === "premio" || type === "ventaja";

/** The whole euros of spend a reward or perk may be moved to, or null for any other row. */
export const spendRange = (program: Program, n: number): { min: number; max: number } | null => {
  const at = program.lad.ms.findIndex((m) => m.n === n);

  if (at < 0 || !movable(program.lad.ms[at].type)) return null;

  return geometryOf(program, at).range;
};

export const moveMilestone = (program: Program, n: number, realSpend: number): SwapResult => {
  const at = program.lad.ms.findIndex((m) => m.n === n);

  if (at < 0 || !movable(program.lad.ms[at].type)) return fail(THRESHOLD_REFUSALS.notReward);
  if (!Number.isInteger(realSpend) || realSpend < 1) return fail(THRESHOLD_REFUSALS.notWhole);

  const { thAt, range } = geometryOf(program, at);

  if (!range) return fail(THRESHOLD_REFUSALS.noRoom);

  if (realSpend < range.min || realSpend > range.max) {
    return fail(`El gasto tiene que estar entre ${euros(range.min)} y ${euros(range.max)}.`);
  }

  const th = thAt(realSpend);
  const next = structuredClone(program);

  next.lad.ms[at].th = th;
  // A reward keeps its own copy of the milestone; the two must never disagree.
  for (const c of next.chosen) if (c.m.n === n) c.m.th = th;

  next.realTh = realThresholds(next.lad.ms);
  next.diamondReal = next.realTh[next.lad.last.n];

  return { ok: true, program: retotal(next) };
};
