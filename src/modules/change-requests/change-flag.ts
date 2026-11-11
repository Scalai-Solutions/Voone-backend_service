import type { Prisma } from "@prisma/client";

import { logger } from "../../common/logger/logger";
import { compareFiveYears } from "../onboarding/comparison";
import { isGiftable, manualCandidates, manualRefusal } from "../onboarding/engine";
import type {
  Answers,
  Candidate,
  ClassifiedItem,
  Program,
  RewardOption
} from "../onboarding/engine.types";
import { MANUAL_REFUSALS, replaceReward, swapRewardToItem } from "../onboarding/swap";
import { rewardsUsing } from "./catalogue-changes";
import type { WhatIfYear } from "./change-flag-present";

/**
 * The "what if" behind a change request's flag: what the clinic's five-year cumulative net would be
 * if its reward ticket (or a price edit of a service that is a live reward) were applied.
 *
 * Pure and total. It works on a programme row and the clinic's CURRENT classified catalogue, runs
 * the engine's own swap and comparison on a copy, and never mutates what it was given. Every
 * failure is a `none` with a reason; nothing here throws, because a flag must never block a ticket.
 *
 * Three series: `live` (the programme as it stands; for a price edit, priced at the item's price
 * today), `proposed` (with the change) and `recommended` (the engine's own plan). No gift, cost or value is in the result; the caller
 * decides how much of it a clinic's browser may see.
 */

export interface WhatIfRow {
  output: unknown;
  answers: unknown;
  catalogSnapshot: unknown;
  engineVersion?: string;
  configVersion?: string;
}

export type WhatIfRequest =
  | { type: "REWARD"; milestone?: number; itemId?: string; text?: string }
  /** The caller resolves the treatment id to the catalogue row's `externalId`. */
  | { type: "SERVICE_EDIT"; externalId: string; priceEuro: number };

export type WhatIf =
  | {
      status: "ok";
      years: WhatIfYear[];
      inputs: { clients: number; ticket: number };
      reason: string | null;
    }
  | { status: "unpriced" }
  | { status: "none"; reason: string; blocked?: Blocked };

/**
 * Why the owner's pick cannot be simulated at all: it would put the same gift in two consecutive
 * milestones, or the item cannot be a reward. The owner is told that much and nothing else.
 */
export type Blocked = "repeat" | "unavailable";

const none = (reason: string, blocked?: Blocked): WhatIf =>
  blocked ? { status: "none", reason, blocked } : { status: "none", reason };

/**
 * A proposed programme, or why there is nothing to simulate. A price edit also carries the
 * `baseline`: the programme priced at the item's CURRENT price, the fair "live" to compare with.
 */
type Proposal = { ok: true; program: Program; baseline?: Program } | { ok: false; result: WhatIf };

const refused = (reason: string, blocked?: Blocked): Proposal => ({
  ok: false,
  result: none(reason, blocked)
});

const GENERIC_REFUSAL = "This swap is not allowed for this programme.";

/** The swap's refusals are Spanish copy for the admin screen of the engine; Voone's flag speaks English. */
const KNOWN_REFUSALS = new Map<string, string>([
  [
    "Ese hito no tiene un premio que se pueda cambiar.",
    "That milestone has no reward that can be changed."
  ],
  ["Esa alternativa no existe.", "That alternative does not exist."],
  ["Ese artículo no está en el catálogo.", "That item is not in the programme's catalogue."],
  [MANUAL_REFUSALS.price, "That item has no price, so it cannot be a reward."],
  [MANUAL_REFUSALS.prize, "The clinic has not marked that item as a prize in its catalogue."],
  [
    MANUAL_REFUSALS.category,
    "That item needs a category in the catalogue before it can be a reward."
  ],
  [MANUAL_REFUSALS.medical, "Medical treatments and products cannot be given as a reward."]
]);

const REPEAT = /^Ese cambio repetiría un regalo en dos hitos seguidos \(hitos (\d+) y (\d+)\)\.$/;

/** What the owner may be told about a refused swap: the repeat, or an item that cannot be a reward. */
const blockedBy = (reason: string): Blocked | undefined => {
  if (REPEAT.test(reason)) return "repeat";

  return Object.values(MANUAL_REFUSALS).includes(reason) ? "unavailable" : undefined;
};

/** Never forwards Spanish: a known refusal is mapped, anything else becomes a generic English line. */
export const englishRefusal = (reason: string): string => {
  const known = KNOWN_REFUSALS.get(reason);

  if (known) return known;

  const repeat = REPEAT.exec(reason);

  return repeat
    ? `That change would repeat a gift in two consecutive milestones (milestones ${repeat[1]} and ${repeat[2]}).`
    : GENERIC_REFUSAL;
};

/**
 * Today's classified row for the item, set in the programme's own catalogue. `program.catalog` is a
 * snapshot from generation, so an item added or repriced since is invisible to the swap until the
 * current row replaces the stale one (or is appended when the snapshot never had it).
 */
const withCurrentRow = (program: Program, row: ClassifiedItem): void => {
  const at = program.catalog.findIndex((item) => item.id === row.id);

  if (at < 0) program.catalog.push(row);
  else program.catalog[at] = row;
};

const proposeReward = (
  output: Program,
  answers: Answers,
  live: ClassifiedItem[],
  milestone: number,
  itemId: string
): Proposal => {
  const row = live.find((item) => item.id === itemId);

  if (!row) return refused("That item is not in the clinic's catalogue.");
  if (!isGiftable(row)) return refused("That item cannot be given as a reward.", "unavailable");

  // An owner's request changes a reward only. The admin's "Cambiar" may turn a perk row into a
  // reward (swapRewardToItem does), but a change request never does.
  if (!output.chosen.some((c) => c.m.n === milestone)) {
    const reason = "Ese hito no tiene un premio que se pueda cambiar.";

    return refused(englishRefusal(reason), blockedBy(reason));
  }

  const copy = structuredClone(output);

  withCurrentRow(copy, structuredClone(row));

  const swapped = swapRewardToItem(copy, answers, milestone, itemId);

  return swapped.ok
    ? { ok: true, program: swapped.program }
    : refused(englishRefusal(swapped.reason), blockedBy(swapped.reason));
};

/** The option with every item `id` replaced by `item`; the totals are the sums over the items. */
const repricedOption = (option: RewardOption, id: string, item: Candidate): RewardOption => {
  const items = option.items.map((it) => (it.id === id ? { ...item } : it));

  return {
    items,
    value: items.reduce((sum, it) => sum + it.value, 0),
    cost: items.reduce((sum, it) => sum + it.cost, 0)
  };
};

const usesItem = (option: RewardOption | undefined, id: string): boolean =>
  Array.isArray(option?.items) && option.items.some((it) => it.id === id);

/** The programme with every use of `externalId` priced as `priceEuro`, or why it cannot be. */
const repriceItem = (
  output: Program,
  answers: Answers,
  current: ClassifiedItem,
  externalId: string,
  priceEuro: number
): Proposal => {
  const repriced: ClassifiedItem = { ...structuredClone(current), price: priceEuro };

  if (manualRefusal(repriced)) return refused("That service cannot be given as a reward.");

  // Priced exactly as the swap prices an item: the same function the catalogue's `giftable` flag uses.
  const [item] = manualCandidates([repriced], answers);
  let program = structuredClone(output);

  withCurrentRow(program, repriced);

  // Each milestone holding the item is replaced the way a swap replaces it, so the totals, the
  // guarantees and the recurring reward are re-derived by the same code, not a second copy of it.
  const holders = program.chosen.flatMap((c, at) => (usesItem(c.o, externalId) ? [at] : []));

  for (const at of holders) {
    const next = replaceReward(
      program,
      answers,
      at,
      repricedOption(program.chosen[at].o, externalId, item),
      -1
    );

    if (!next.ok) return refused(englishRefusal(next.reason));

    program = next.program;
  }

  // A recurring reward that holds the item is repriced too (idempotent when a swap re-picked it).
  if (usesItem(program.rec?.o, externalId)) {
    program.rec = { ...program.rec, o: repricedOption(program.rec.o, externalId, item) };
  }

  return { ok: true, program };
};

const proposeEdit = (
  output: Program,
  answers: Answers,
  live: ClassifiedItem[],
  externalId: string,
  priceEuro: number
): Proposal => {
  if (!Number.isFinite(priceEuro) || !(priceEuro > 0)) return refused("The price is not valid.");

  if (rewardsUsing(output as unknown as Prisma.JsonValue, externalId).length === 0) {
    return refused("That service is not a live reward.");
  }

  const current = live.find((item) => item.id === externalId);

  if (!current) return refused("That service is not in the clinic's catalogue.");

  const proposed = repriceItem(output, answers, current, externalId, priceEuro);

  if (!proposed.ok) return proposed;

  // The stored plan was costed when it was generated; the proposal is priced from today's row. If
  // the catalogue has drifted since (and every applied ticket makes it drift), comparing the two
  // would credit or charge the edit with the drift. So the "live" side is the same programme
  // priced at the item's price today, and a no-op edit reads as exactly nothing.
  const baseline = repriceItem(output, answers, current, externalId, current.price);

  if (!baseline.ok) return baseline;

  return { ok: true, program: proposed.program, baseline: baseline.program };
};

const propose = (
  row: WhatIfRow,
  live: ClassifiedItem[],
  req: WhatIfRequest
): Proposal | { ok: true; unpriced: true } => {
  const output = row.output as Program;
  const answers = row.answers as Answers;

  if (req.type === "SERVICE_EDIT") {
    return proposeEdit(output, answers, live, req.externalId, req.priceEuro);
  }

  if (typeof req.itemId === "string" && req.itemId !== "") {
    if (typeof req.milestone !== "number") return refused("No milestone was given.");

    return proposeReward(output, answers, live, req.milestone, req.itemId);
  }

  // Free text has no representation in a programme, so there is nothing to simulate.
  if (typeof req.text === "string" && req.text.trim() !== "") return { ok: true, unpriced: true };

  return refused("The request names neither an item nor a text.");
};

export const whatIf = (
  row: WhatIfRow,
  liveCatalogue: ClassifiedItem[],
  req: WhatIfRequest
): WhatIf => {
  try {
    const proposal = propose(row, liveCatalogue, req);

    if ("unpriced" in proposal) return { status: "unpriced" };
    if (!proposal.ok) return proposal.result;

    // The same calculator inputs for both plans, so the difference is the change and nothing else.
    const live = compareFiveYears(row);
    const proposed = compareFiveYears({ ...row, output: proposal.program });
    // For a price edit, "live" is the plan at today's price (see proposeEdit); the recommended
    // series, the inputs and the reason always come from the stored row.
    const baseline = proposal.baseline
      ? compareFiveYears({ ...row, output: proposal.baseline })
      : live;

    if (live.years.length !== 5 || proposed.years.length !== 5 || baseline.years.length !== 5) {
      return none("The programme could not be simulated.");
    }

    return {
      status: "ok",
      years: live.years.map((year, i) => ({
        year: year.year,
        liveCumulative: baseline.years[i].currentCumulative,
        proposedCumulative: proposed.years[i].currentCumulative,
        recommendedCumulative: year.recommendedCumulative
      })),
      inputs: { clients: live.inputs.clients, ticket: live.inputs.ticket },
      reason: live.reason
    };
  } catch (error) {
    // Still a none: a flag never blocks a ticket. But a throw here is a bug, not a refusal, so say so.
    logger.error("[change-flag] what-if failed unexpectedly", {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    });

    return none("The programme could not be simulated.");
  }
};
