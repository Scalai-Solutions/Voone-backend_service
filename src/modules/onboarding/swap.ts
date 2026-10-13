import { COST_REVIEW_NOTE, buildGuarantees, candidates, chooseRecurring } from "./engine";
import { ids } from "./engine.math";
import type { Answers, ChosenReward, Program, RewardOption } from "./engine.types";

/**
 * Replacing one reward with an alternative the engine proposed.
 *
 * The guide has the centre edit its programme from "the suggested alternatives", and an edit
 * is exactly where a valid programme can be made invalid. So a swap is not "put this item
 * there": it re-derives everything the change could touch, refuses what would break a rule
 * the centre has no way to see, and lets through what merely costs more — flagged, so the
 * centre decides with the number in front of it.
 *
 * Pure: it takes a programme and returns a new one, never the same object.
 */

export type SwapResult = { ok: true; program: Program } | { ok: false; reason: string };

const fail = (reason: string): SwapResult => ({ ok: false, reason });

const sharesItem = (a: RewardOption, b: RewardOption): boolean =>
  ids(a).some((id) => ids(b).includes(id));

const hasConsecutiveRepeat = (chosen: ChosenReward[]): boolean =>
  chosen.some((c, i) => i > 0 && sharesItem(c.o, chosen[i - 1].o));

/** The "best reward first" guarantee, as the engine words it. */
const BRONCE_FIRST = "En Bronce el mejor premio es el primero";

const holds = (program: Program, text: string): boolean =>
  program.guarantees.find(([t]) => t === text)?.[1] ?? true;

export const swapReward = (
  program: Program,
  answers: Answers,
  milestone: number,
  alternative: number
): SwapResult => {
  const next = structuredClone(program);
  const at = next.chosen.findIndex((c) => c.m.n === milestone);

  if (at < 0) return fail("Ese hito no tiene un premio que se pueda cambiar.");

  const entry = next.chosen[at];
  const replacement = entry.alts[alternative];

  if (!replacement) return fail("Esa alternativa no existe.");

  const previous = entry.o;

  entry.o = replacement;
  // The reward swapped out becomes an alternative, so the centre can undo the change.
  entry.alts = [previous, ...entry.alts.filter((_, k) => k !== alternative)].slice(0, 2);

  // An alternative elsewhere that uses an item this reward now holds would, if taken, put
  // the same item in the ladder twice. They were valid only while nobody held the item.
  const taken = new Set(ids(replacement));

  next.chosen.forEach((c, k) => {
    if (k !== at) c.alts = c.alts.filter((a) => !ids(a).some((id) => taken.has(id)));
  });

  if (hasConsecutiveRepeat(next.chosen)) {
    return fail("Ese cambio repetiría un regalo en dos hitos seguidos.");
  }

  // The ladder must keep climbing. Bronce is exempt from ordering inside itself — its best
  // reward leads — but everything after it must not fall below what came before.
  const bronce = next.chosen.filter((c) => c.m.tramo === 1);
  const later = next.chosen.filter((c) => c.m.tramo > 1);
  const ceiling = Math.max(0, ...bronce.map((c) => c.o.value));
  let floor = ceiling;

  for (const c of later) {
    if (c.o.value < floor) {
      return fail("Ese cambio dejaría un premio con menos valor que el anterior.");
    }

    floor = c.o.value;
  }

  // The recurring reward must be worth at least the last ladder reward, so a swap that
  // raises the last one has to re-pick it.
  if (at === next.chosen.length - 1) {
    const cands = candidates(next.catalog, answers);
    const rec = chooseRecurring(next.est.A, replacement.value, next.lad.inv, cands);

    if (rec.o) next.rec = rec;
  }

  next.totalCost = next.chosen.reduce((sum, c) => sum + c.o.cost, 0) + next.perkCost;
  next.costPct = next.totalCost / next.diamondReal;
  next.guarantees = buildGuarantees(next.lad, next.est, next.chosen, next.costPct);

  // Only refuse a Bronce rule the programme held before: one that was already unachievable
  // (and said so) is not the centre's doing and not theirs to be blocked on.
  if (holds(program, BRONCE_FIRST) && !holds(next, BRONCE_FIRST)) {
    return fail("En Bronce el mejor premio tiene que ir el primero.");
  }

  // Cost is NOT a refusal. A dearer alternative is a legitimate choice; what the centre must
  // not be able to do is make one without being told. So the blocking note follows the number.
  next.review = next.review.filter((note) => note !== COST_REVIEW_NOTE);

  if (next.costPct > next.lad.inv * 1.5) next.review.push(COST_REVIEW_NOTE);

  return { ok: true, program: next };
};
