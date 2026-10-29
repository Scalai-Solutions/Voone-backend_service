import {
  COST_REVIEW_NOTE,
  buildGuarantees,
  candidates,
  chooseRecurring,
  manualCandidates,
  manualRefusal,
  type ManualRefusal
} from "./engine";
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

/** The position of the first reward that shares a gift with the one before it, if any. */
const consecutiveRepeatAt = (chosen: ChosenReward[]): number =>
  chosen.findIndex((c, i) => i > 0 && sharesItem(c.o, chosen[i - 1].o));

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
  const at = program.chosen.findIndex((c) => c.m.n === milestone);

  if (at < 0) return fail("Ese hito no tiene un premio que se pueda cambiar.");

  const replacement = program.chosen[at].alts[alternative];

  if (!replacement) return fail("Esa alternativa no existe.");

  return replaceReward(program, answers, at, replacement, alternative);
};

const MANUAL_REFUSALS: Record<ManualRefusal, string> = {
  price: "Ese artículo no tiene precio, así que no puede ser un premio.",
  category: "Asigna una categoría a este artículo en el catálogo antes de usarlo como premio.",
  medical: "Los tratamientos y productos médicos no se pueden dar como premio."
};

/**
 * Gives a milestone any item from the centre's catalogue that the admin may hand-pick as a reward
 * (founders' E2E item 28). That is wider than what the engine proposes from: waxing and diagnosis
 * are allowed, only medical items are not (see `manualCandidates`). The same checks as an engine
 * alternative apply, so a ladder that stops climbing is still refused; what it adds is that the
 * choice is no longer limited to the two the engine proposed, and a dearer one is flagged, not
 * refused.
 */
export const swapRewardToItem = (
  program: Program,
  answers: Answers,
  milestone: number,
  itemId: string
): SwapResult => {
  const at = program.chosen.findIndex((c) => c.m.n === milestone);

  if (at < 0) return fail("Ese hito no tiene un premio que se pueda cambiar.");

  const row = program.catalog.find((candidate) => candidate.id === itemId);

  if (!row) return fail("Ese artículo no está en el catálogo.");

  const refusal = manualRefusal(row);

  if (refusal) return fail(MANUAL_REFUSALS[refusal]);

  // Priced exactly as the engine prices a candidate, through the same function the catalogue's
  // `giftable` flag is derived from.
  const [item] = manualCandidates([row], answers);

  return replaceReward(
    program,
    answers,
    at,
    { items: [item], value: item.value, cost: item.cost },
    -1
  );
};

const replaceReward = (
  program: Program,
  answers: Answers,
  at: number,
  replacement: RewardOption,
  alternativeIndex: number
): SwapResult => {
  const next = structuredClone(program);
  const entry = next.chosen[at];
  const previous = entry.o;

  entry.o = replacement;
  // A label was written for the reward that is leaving; on the new one it would be a lie.
  delete entry.label;
  // The reward swapped out becomes an alternative, so the centre can undo the change.
  entry.alts = [previous, ...entry.alts.filter((_, k) => k !== alternativeIndex)].slice(0, 2);

  // An alternative elsewhere that uses an item this reward now holds would, if taken, put
  // the same item in the ladder twice. They were valid only while nobody held the item.
  const taken = new Set(ids(replacement));

  next.chosen.forEach((c, k) => {
    if (k !== at) c.alts = c.alts.filter((a) => !ids(a).some((id) => taken.has(id)));
  });

  const repeat = consecutiveRepeatAt(next.chosen);

  if (repeat > 0) {
    return fail(
      `Ese cambio repetiría un regalo en dos hitos seguidos (hitos ${next.chosen[repeat - 1].m.n} y ${next.chosen[repeat].m.n}).`
    );
  }

  // The ladder must keep climbing. Bronce is exempt from ordering inside itself — its best
  // reward leads — but everything after it must not fall below what came before.
  const bronce = next.chosen.filter((c) => c.m.tramo === 1);
  const later = next.chosen.filter((c) => c.m.tramo > 1);
  const ceiling = Math.max(0, ...bronce.map((c) => c.o.value));
  let floor = ceiling;
  let floorAt = bronce.find((c) => c.o.value === ceiling)?.m.n;

  for (const c of later) {
    if (c.o.value < floor) {
      return fail(
        `Ese cambio dejaría el premio del hito ${c.m.n} con menos valor que el del hito ${floorAt ?? "anterior"}.`
      );
    }

    floor = c.o.value;
    floorAt = c.m.n;
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
