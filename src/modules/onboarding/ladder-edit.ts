import { realThresholds } from "./engine";
import type { ChosenReward, Milestone, Program } from "./engine.types";
import { perkCostOf, retotal, type SwapResult } from "./swap";
import { geometryBetween } from "./threshold";

/**
 * Adding a milestone to a tier band, and removing one.
 *
 * A milestone is identified by its `n`, which issued rewards are keyed on, so no `n` ever changes:
 * a removed milestone leaves a gap, and an added one takes the next number after the highest. The
 * ladder itself stays in order of spend, which is what everything that walks it relies on. Tier
 * steps are never added or removed: they are where the tiers begin.
 *
 * Pure: each takes a programme and returns a new one, never the same object.
 */

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const euros = (n: number): string => `${n.toLocaleString("es-ES")} €`;

export const LADDER_REFUSALS = {
  band: "Ese nivel no existe en la escalera.",
  noRoom: "No queda margen en este nivel para añadir otro hito.",
  taken: "Ya hay un hito con ese gasto. Elige otro importe.",
  notRemovable: "Solo se puede quitar un premio o una ventaja.",
  notWhole: "El gasto tiene que ser un número entero de euros, mayor que 0."
} as const;

/** The tier steps around band `tramo` (1 to 4): where it starts (none for Bronce) and where it ends. */
const bandEdges = (program: Program, tramo: number) => ({
  start: program.lad.ms.find((m) => m.type === "nivel" && m.tramo === tramo - 1),
  end: program.lad.ms.find((m) => m.type === "nivel" && m.tramo === tramo)
});

/** The whole euros of spend a new milestone in band `tramo` may be added at, or null. */
export const bandRange = (program: Program, tramo: number): { min: number; max: number } | null => {
  const { start, end } = bandEdges(program, tramo);

  return end ? geometryBetween(program, start, end, tramo).range : null;
};

/**
 * Adds an empty reward slot at `realSpend` (whole euros paid) in band `tramo`. The caller fills it
 * with a swap at once, which re-derives the totals; on its own an empty slot is never stored.
 */
export const insertMilestone = (
  program: Program,
  tramo: number,
  realSpend: number
): { ok: true; program: Program; n: number } | { ok: false; reason: string } => {
  const { start, end } = bandEdges(program, tramo);

  if (!end) return fail(LADDER_REFUSALS.band);
  if (!Number.isInteger(realSpend) || realSpend < 1) return fail(LADDER_REFUSALS.notWhole);

  const { thAt, range } = geometryBetween(program, start, end, tramo);

  if (!range) return fail(LADDER_REFUSALS.noRoom);

  if (realSpend < range.min || realSpend > range.max) {
    return fail(`El gasto tiene que estar entre ${euros(range.min)} y ${euros(range.max)}.`);
  }

  const th = thAt(realSpend);

  // Two milestones on one threshold would be crossed together and read as one row.
  if (program.lad.ms.some((m) => m.th === th)) return fail(LADDER_REFUSALS.taken);

  const n = Math.max(...program.lad.ms.map((m) => m.n)) + 1;
  const milestone: Milestone = {
    n,
    tramo,
    type: "premio",
    th,
    cb: 0,
    cap: 0,
    V: 0,
    early: tramo === 1
  };
  const entry: ChosenReward = {
    m: structuredClone(milestone),
    o: { items: [], value: 0, cost: 0 },
    alts: []
  };
  const next = structuredClone(program);
  const at = next.lad.ms.findIndex((m) => m.th > th);
  const slot = next.chosen.findIndex((c) => c.m.th > th);

  next.lad.ms.splice(at < 0 ? next.lad.ms.length : at, 0, milestone);
  next.chosen.splice(slot < 0 ? next.chosen.length : slot, 0, entry);
  next.realTh = realThresholds(next.lad.ms, next.tierRules);
  next.diamondReal = next.realTh[next.lad.last.n];

  return { ok: true, program: next, n };
};

/** Removes a reward or perk milestone. Every other row keeps its spend. */
export const removeMilestone = (program: Program, n: number): SwapResult => {
  const at = program.lad.ms.findIndex((m) => m.n === n);

  if (at < 0 || program.lad.ms[at].type === "nivel") return fail(LADDER_REFUSALS.notRemovable);

  const next = structuredClone(program);

  next.lad.ms.splice(at, 1);
  next.chosen = next.chosen.filter((c) => c.m.n !== n);
  next.perkCost = perkCostOf(next.lad.ms);
  next.realTh = realThresholds(next.lad.ms, next.tierRules);
  next.diamondReal = next.realTh[next.lad.last.n];

  return { ok: true, program: retotal(next) };
};
