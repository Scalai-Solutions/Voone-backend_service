import {
  COST_REVIEW_NOTE,
  DOUBLE_PERK_TEXT,
  buildGuarantees,
  candidates,
  chooseRecurring,
  doublePerkCost,
  manualCandidates,
  manualRefusal,
  type ManualRefusal
} from "./engine";
import { ids } from "./engine.math";
import type {
  Answers,
  Candidate,
  ChosenReward,
  Milestone,
  Program,
  RewardOption,
  SpecialReward
} from "./engine.types";

/**
 * Replacing one reward with an alternative the engine proposed.
 *
 * The guide has the centre edit its programme from "the suggested alternatives", and an edit
 * is exactly where a valid programme can be made invalid. So a swap is not "put this item
 * there": it re-derives everything the change could touch, refuses only what would break a
 * promise made to clients (a gift the centre may not give), and lets through everything else: a
 * dearer reward is flagged, and a cheaper one, a different order, or the same gift on two
 * milestones (even in a row), is the admin's call. The admin sees the money consequence, not a
 * refusal.
 *
 * Pure: it takes a programme and returns a new one, never the same object.
 */

export type SwapResult = { ok: true; program: Program } | { ok: false; reason: string };

const fail = (reason: string): SwapResult => ({ ok: false, reason });

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

const NO_SLOT = "Ese hito no tiene un premio que se pueda cambiar.";

/** What the ladder's perks cost the centre, as the engine sums it. */
export const perkCostOf = (ms: readonly Milestone[]): number =>
  ms.reduce((sum, m) => sum + (m.type === "ventaja" ? (m.perk?.cost ?? 0) : 0), 0);

/**
 * The reward slot at a milestone, for a choice made on the "Cambiar" panel.
 *
 * Every row but a tier step can be changed there. A perk milestone has no reward slot, so it is
 * given one, empty, which the swap fills at once: from then on it is a reward like the others, and
 * what it becomes is issued like any reward's (double points and a surprise still as their perks,
 * see `programView`). The perk's cost leaves the total with it. Returns a copy when it converts;
 * null for a tier step or a milestone that does not exist.
 */
const rewardSlot = (
  program: Program,
  milestone: number
): { program: Program; at: number } | null => {
  const at = program.chosen.findIndex((c) => c.m.n === milestone);

  if (at >= 0) return { program, at };

  const i = program.lad.ms.findIndex((m) => m.n === milestone);

  if (i < 0 || program.lad.ms[i].type !== "ventaja") return null;

  const next = structuredClone(program);
  const slot = next.lad.ms[i];

  slot.type = "premio";
  delete slot.perk;
  next.perkCost = perkCostOf(next.lad.ms);

  const entry: ChosenReward = {
    m: structuredClone(slot),
    o: { items: [], value: 0, cost: 0 },
    alts: []
  };
  // `chosen` is in ladder order, which the rest of the programme relies on. By spend, not by `n`:
  // a milestone the admin added has a new, higher `n` wherever it sits.
  const after = next.chosen.findIndex((c) => c.m.th > slot.th);
  const insertAt = after < 0 ? next.chosen.length : after;

  next.chosen.splice(insertAt, 0, entry);

  return { program: next, at: insertAt };
};

export const MANUAL_REFUSALS: Record<ManualRefusal, string> = {
  price: "Ese artículo no tiene precio, así que no puede ser un premio.",
  prize: "El centro no ha marcado este artículo como premio (Y) en su catálogo.",
  category: "Asigna una categoría a este artículo en el catálogo antes de usarlo como premio.",
  medical: "Los tratamientos y productos médicos no se pueden dar como premio."
};

/**
 * Gives a milestone any item from the centre's catalogue that the admin may hand-pick as a reward
 * (founders' E2E item 28). That is wider than what the engine proposes from: waxing and diagnosis
 * are allowed, only medical items are not (see `manualCandidates`). The same checks as an engine
 * alternative apply; what it adds is that the choice is no longer limited to the two the engine
 * proposed, and a dearer one is flagged, not refused. A reward cheaper than the one before it in
 * a later tier is allowed too.
 */
export const swapRewardToItem = (
  program: Program,
  answers: Answers,
  milestone: number,
  itemId: string
): SwapResult => {
  const slot = rewardSlot(program, milestone);

  if (!slot) return fail(NO_SLOT);

  const reward = rewardFor(program, answers, { itemId });

  if (!reward.ok) return reward;

  return replaceReward(slot.program, answers, slot.at, reward.o, -1);
};

/** A reward that is not a catalogue item, as the admin picks it on "Cambiar". */
export type SpecialChoice =
  { kind: "doble" } | { kind: "sorpresa" } | { kind: "libre"; name: string; priceEuro: number };

/**
 * What a free-text reward is reckoned to cost the centre, as a share of the price the admin gave.
 * The cabin-treatment ratio: the reward could be anything, and this number stays internal (it only
 * feeds the cost share and the five-year comparison, never a screen the centre sees).
 */
export const FREE_REWARD_COST_RATIO = 0.2;

/** The surprise's words. Reception picks the gift from the pool when it is redeemed. */
export const SURPRISE_TEXT = {
  name: "Premio sorpresa",
  desc: "El centro elige el regalo en el momento del canje."
} as const;

export const EMPTY_SURPRISE_POOL =
  "Ningún artículo del catálogo puede ser premio todavía, así que no hay entre qué elegir la sorpresa.";

export const FREE_REWARD_REFUSALS = {
  name: "Escribe el premio.",
  price: "El precio del premio tiene que ser mayor que 0."
} as const;

const byNameThenId = (a: Candidate, b: Candidate): number =>
  a.name.localeCompare(b.name, "es") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Turns a milestone's reward into double points, a surprise, or a free text with its price.
 *
 * The milestone stays a reward slot; only what it issues changes (see `programView`): double
 * points is issued as the same perk the engine places on the ladder, so the next payment spends it
 * automatically; a surprise is issued as the surprise perk, with `pool` as what reception may give
 * (the caller passes every item of today's catalogue the admin could hand-pick, medical excluded);
 * a free text is a gift worth its price.
 */
export const swapRewardToSpecial = (
  program: Program,
  answers: Answers,
  milestone: number,
  choice: SpecialChoice,
  pool: readonly Candidate[] = []
): SwapResult => {
  const slot = rewardSlot(program, milestone);

  if (!slot) return fail(NO_SLOT);

  // Priced on the programme holding the slot (a copy when a perk was converted).
  const reward = rewardFor(slot.program, answers, choice, pool);

  if (!reward.ok) return reward;

  return replaceReward(slot.program, answers, slot.at, reward.o, -1, reward.special);
};

/** One of the "Cambiar" panel's choices other than an engine alternative. */
export type PanelChoice = { itemId: string } | SpecialChoice;

type Priced =
  { ok: true; o: RewardOption; special?: SpecialReward } | { ok: false; reason: string };

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/**
 * What a panel choice gives and costs, for a ladder reward and the reward after Diamante alike.
 *
 * A catalogue item is any the admin may hand-pick (medical never), priced exactly as the engine
 * prices a candidate, through the same function the catalogue's `giftable` flag is derived from.
 * Double points is the very perk the engine places on the ladder; a surprise carries `pool` (every
 * item of today's catalogue the admin could hand-pick) as what reception may give; a free text is a
 * gift worth its price.
 */
const rewardFor = (
  program: Program,
  answers: Answers,
  choice: PanelChoice,
  pool: readonly Candidate[] = []
): Priced => {
  if ("itemId" in choice) {
    const row = program.catalog.find((candidate) => candidate.id === choice.itemId);

    if (!row) return refuse("Ese artículo no está en el catálogo.");

    const refusal = manualRefusal(row);

    if (refusal) return refuse(MANUAL_REFUSALS[refusal]);

    const [item] = manualCandidates([row], answers);

    return { ok: true, o: { items: [item], value: item.value, cost: item.cost } };
  }

  if (choice.kind === "doble") {
    return {
      ok: true,
      o: { items: [], value: 0, cost: doublePerkCost(program.lad.inv, program.est.ticket) },
      special: { kind: "doble", ...DOUBLE_PERK_TEXT }
    };
  }

  if (choice.kind === "sorpresa") {
    if (pool.length === 0) return refuse(EMPTY_SURPRISE_POOL);

    // Sorted so the same catalogue always stores the same pool, in the order reception reads it.
    const sorted = pool.map((c) => ({ ...c })).sort(byNameThenId);
    const cost = sorted.reduce((sum, c) => sum + c.cost, 0) / sorted.length;

    return {
      ok: true,
      o: { items: [], value: 0, cost },
      special: { kind: "sorpresa", ...SURPRISE_TEXT, pool: sorted }
    };
  }

  const name = choice.name.trim();

  if (!name) return refuse(FREE_REWARD_REFUSALS.name);
  if (!(Number.isFinite(choice.priceEuro) && choice.priceEuro > 0)) {
    return refuse(FREE_REWARD_REFUSALS.price);
  }

  const value = Math.round(choice.priceEuro * 100) / 100;

  return {
    ok: true,
    o: { items: [], value, cost: value * FREE_REWARD_COST_RATIO },
    special: { kind: "libre", name, desc: "" }
  };
};

/**
 * Sets the reward that repeats after Diamante to one of the panel's choices. It is the admin's from
 * then on (`picked`): a swap of the last ladder reward no longer re-picks it. How often it repeats
 * is kept, and a label written for the reward that is leaving goes with it. It is issued as what it
 * is (see `programView`): double points and a surprise as their perks.
 */
export const swapRecurring = (
  program: Program,
  answers: Answers,
  choice: PanelChoice,
  pool: readonly Candidate[] = []
): SwapResult => {
  const reward = rewardFor(program, answers, choice, pool);

  if (!reward.ok) return reward;

  const next = structuredClone(program);

  next.rec = {
    every: next.rec.every,
    o: reward.o,
    ...(reward.special ? { special: reward.special } : {}),
    picked: true
  };

  return { ok: true, program: next };
};

/**
 * Puts `replacement` in the reward slot at `at`. `special` says it is double points, a surprise
 * or a free text; without it the reward is the items in `replacement`, and a special reward the
 * slot held before is gone.
 */
export const replaceReward = (
  program: Program,
  answers: Answers,
  at: number,
  replacement: RewardOption,
  alternativeIndex: number,
  special?: SpecialReward
): SwapResult => {
  const next = structuredClone(program);
  const entry = next.chosen[at];
  const previous = entry.o;
  // Only catalogue items can be offered back: a special reward has none to show as an alternative.
  const previousIsItems = !entry.special && previous.items.length > 0;

  entry.o = replacement;

  if (special) entry.special = structuredClone(special);
  else delete entry.special;

  // A label was written for the reward that is leaving; on the new one it would be a lie.
  delete entry.label;
  // The reward swapped out becomes an alternative, so the centre can undo the change.
  const kept = entry.alts.filter((_, k) => k !== alternativeIndex);

  entry.alts = (previousIsItems ? [previous, ...kept] : kept).slice(0, 2);

  // An alternative elsewhere that uses an item this reward now holds would, if taken, put
  // the same item in the ladder twice. They were valid only while nobody held the item.
  const taken = new Set(ids(replacement));

  next.chosen.forEach((c, k) => {
    if (k !== at) c.alts = c.alts.filter((a) => !ids(a).some((id) => taken.has(id)));
  });

  // The recurring reward must be worth at least the last ladder reward, so a swap that
  // raises the last one has to re-pick it. A last reward with no retail value (double points,
  // a surprise) says nothing about that, and must not cheapen the reward after Diamante.
  // One the admin chose herself is hers, whatever the ladder does.
  if (at === next.chosen.length - 1 && replacement.value > 0 && !next.rec.picked) {
    const cands = candidates(next.catalog, answers);
    const rec = chooseRecurring(next.est.A, replacement.value, next.lad.inv, cands);

    if (rec.o) next.rec = rec;
  }

  return { ok: true, program: retotal(next) };
};

/**
 * Re-derives what an edit of the rewards or of the thresholds can move: the total cost, its share
 * of what a client pays to reach Diamante, the guarantees, and the cost note. Mutates and returns
 * `next`, which the caller has already cloned.
 */
export const retotal = (next: Program): Program => {
  next.totalCost = next.chosen.reduce((sum, c) => sum + c.o.cost, 0) + next.perkCost;
  next.costPct = next.totalCost / next.diamondReal;
  next.guarantees = buildGuarantees(next.lad, next.est, next.chosen, next.costPct);

  // Cost is NOT a refusal. A dearer alternative is a legitimate choice; what the centre must
  // not be able to do is make one without being told. So the note follows the number.
  next.review = next.review.filter((note) => note !== COST_REVIEW_NOTE);

  if (next.costPct > next.lad.inv * 1.5) next.review.push(COST_REVIEW_NOTE);

  return next;
};
