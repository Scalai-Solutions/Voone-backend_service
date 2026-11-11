import { MemberRewardKind } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

// Settings of the original programme: this suite is not about the tuned ladder (tuning.test.ts is).
vi.mock("../../src/modules/onboarding/engine.config", async (importOriginal) => {
  const { referenceTuningMock } = await import("./reference-tuning");

  return referenceTuningMock(importOriginal as never);
});

import {
  blockingReview,
  classify,
  DOUBLE_PERK_TEXT,
  informationalNotes,
  manualCandidates,
  ORDER_REVIEW_NOTE,
  run
} from "../../src/modules/onboarding/engine";
import type {
  Answers,
  CatalogItem,
  Candidate,
  Program
} from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { presentProgram, rewardKindOf } from "../../src/modules/onboarding/presentation";
import { programView } from "../../src/modules/onboarding/runtime/program-view";
import {
  isDoublePointsPerk,
  isInSurprisePool,
  milestonesCrossed,
  nextRewardFor
} from "../../src/modules/onboarding/runtime/rules";
import { giftSaving } from "../../src/modules/onboarding/runtime/savings";
import {
  EMPTY_SURPRISE_POOL,
  FREE_REWARD_COST_RATIO,
  FREE_REWARD_REFUSALS,
  SURPRISE_TEXT,
  swapRewardToItem,
  swapRewardToSpecial,
  type SpecialChoice
} from "../../src/modules/onboarding/swap";
import { applyTexts } from "../../src/modules/onboarding/texts";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * A reward the admin turns into double points, a surprise or a free text with its price.
 *
 * The milestone stays a reward slot; what changes is what a member is issued for it. These tests
 * follow each kind from the swap to the issued reward, through the same functions the visit, the
 * reception screen and the savings use, so "works like the double-points perk" is checked rather
 * than assumed.
 */
const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const fresh = (): Program => {
  const result = run(catalog as CatalogItem[], ANSWERS);

  if (isEngineError(result)) throw new Error(result.error);

  return result;
};

const pool = (): Candidate[] => manualCandidates(classify(catalog as CatalogItem[]), ANSWERS);

const special = (p: Program, n: number, choice: SpecialChoice, from = pool()): Program => {
  const result = swapRewardToSpecial(p, ANSWERS, n, choice, from);

  if (!result.ok) throw new Error(result.reason);

  return result.program;
};

const entry = (p: Program, n: number) => p.chosen.find((c) => c.m.n === n)!;
/** A reward in the middle of the ladder, so the recurring reward is not involved. */
const middle = (p: Program): number => p.chosen[1].m.n;
const last = (p: Program): number => p.chosen[p.chosen.length - 1].m.n;
const issueAt = (p: Program, n: number) => programView(p).milestones.find((m) => m.n === n)!.issue!;
const presentedAt = (p: Program, n: number) =>
  presentProgram(p, { forAdmin: true }).ladder.find((m) => m.n === n)!;

describe("double points on a reward milestone", () => {
  it("holds no item, is worth nothing at retail, and costs what the double-points perk costs", () => {
    const p = fresh();
    const n = middle(p);
    const next = special(p, n, { kind: "doble" });

    expect(entry(next, n).special).toEqual({ kind: "doble", ...DOUBLE_PERK_TEXT });
    expect(entry(next, n).o).toEqual({
      items: [],
      value: 0,
      cost: p.lad.inv * p.est.ticket
    });
    // The engine's own double-points perks cost the same.
    const perk = p.lad.ms.find((m) => m.perk?.kind === "doble")!.perk!;

    expect(entry(next, n).o.cost).toBeCloseTo(perk.cost, 10);
  });

  it("is issued as the double-points perk, so the next payment spends it on its own", () => {
    const p = fresh();
    const n = middle(p);
    const issue = issueAt(special(p, n, { kind: "doble" }), n);

    expect(issue).toEqual({
      kind: "VENTAJA",
      title: DOUBLE_PERK_TEXT.name,
      detail: { perk: "doble", description: DOUBLE_PERK_TEXT.desc }
    });
    // What the visit credit, the card's boost and the reception screen test for.
    expect(isDoublePointsPerk(issue.kind, issue.detail)).toBe(true);
    // And it never counts as money saved.
    expect(giftSaving(MemberRewardKind.VENTAJA, issue.detail, { sorpresa: 500 })).toBeNull();
  });

  it("is crossed like any milestone and announced as the next reward", () => {
    const p = special(fresh(), middle(fresh()), { kind: "doble" });
    const view = programView(p);
    const m = view.milestones.find((x) => x.n === middle(p))!;

    expect(milestonesCrossed(view, m.th - 1, m.th).map((x) => x.n)).toContain(m.n);
    expect(nextRewardFor(view, m.th - 1)?.title).toBe(DOUBLE_PERK_TEXT.name);
  });

  it("shows on the admin's screen as double points, with its description and no value", () => {
    const p = fresh();
    const n = middle(p);
    const shown = presentedAt(special(p, n, { kind: "doble" }), n);

    expect(shown.reward).toMatchObject({
      name: DOUBLE_PERK_TEXT.name,
      kind: "doble",
      description: DOUBLE_PERK_TEXT.desc,
      items: []
    });
    expect(shown.rewardValueEuro).toBe(0);
  });

  it("does not cheapen the reward after Diamante when it is the last reward", () => {
    const p = fresh();
    const next = special(p, last(p), { kind: "doble" });

    expect(next.rec).toEqual(p.rec);
  });
});

describe("a surprise on a reward milestone", () => {
  it("may be any item the admin could hand-pick, listed by name", () => {
    const p = fresh();
    const n = middle(p);
    const from = pool();
    const next = special(p, n, { kind: "sorpresa" }, from);
    const stored = entry(next, n).special!;

    expect(stored.kind).toBe("sorpresa");
    expect(stored.name).toBe(SURPRISE_TEXT.name);
    expect(stored.pool!.map((c) => c.id).sort()).toEqual(from.map((c) => c.id).sort());

    const names = stored.pool!.map((c) => c.name);

    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "es")));
    // No medical item: the pool is the hand-pick rule's, which excludes them.
    expect(stored.pool!.some((c) => c.cat === "MFA" || c.cat === "MNF")).toBe(false);
  });

  it("costs the average of its pool and is worth nothing fixed at retail", () => {
    const p = fresh();
    const n = middle(p);
    const from = pool();
    const next = special(p, n, { kind: "sorpresa" }, from);
    const average = from.reduce((s, c) => s + c.cost, 0) / from.length;

    expect(entry(next, n).o.items).toEqual([]);
    expect(entry(next, n).o.value).toBe(0);
    expect(entry(next, n).o.cost).toBeCloseTo(average, 10);
  });

  it("is issued as the surprise perk, redeemed by picking one gift of its pool", () => {
    const p = fresh();
    const n = middle(p);
    const issue = issueAt(special(p, n, { kind: "sorpresa" }), n);

    expect(issue.kind).toBe("VENTAJA");
    expect(issue.title).toBe(SURPRISE_TEXT.name);

    const detail = issue.detail as { perk: string; pool: Array<{ id: string; name: string }> };

    expect(detail.perk).toBe("sorpresa");
    expect(isDoublePointsPerk(issue.kind, issue.detail)).toBe(false);
    expect(isInSurprisePool(detail.pool, detail.pool[0].id)).toBe(true);
    expect(isInSurprisePool(detail.pool, "no-such-item")).toBe(false);
    // Only ids and names travel with an issued reward, never a cost.
    expect(Object.keys(detail.pool[0]).sort()).toEqual(["id", "name"]);
    // It saves what the centre says a surprise is worth, as the engine's surprise does.
    expect(giftSaving(MemberRewardKind.VENTAJA, issue.detail, { sorpresa: 1500 })).toEqual({
      kind: "PERK",
      cents: 1500
    });
  });

  it("is refused when the catalogue has nothing that can be given", () => {
    const p = fresh();

    expect(swapRewardToSpecial(p, ANSWERS, middle(p), { kind: "sorpresa" }, [])).toEqual({
      ok: false,
      reason: EMPTY_SURPRISE_POOL
    });
  });
});

describe("a free text with its price", () => {
  const libre = (name: string, priceEuro: number): SpecialChoice => ({
    kind: "libre",
    name,
    priceEuro
  });

  it("is titled with the text, worth its price, and costs a fixed share of it", () => {
    const p = fresh();
    const n = middle(p);
    const next = special(p, n, libre("  Manicura de regalo  ", 24.5));

    expect(entry(next, n).special).toEqual({ kind: "libre", name: "Manicura de regalo", desc: "" });
    expect(entry(next, n).o).toEqual({
      items: [],
      value: 24.5,
      cost: 24.5 * FREE_REWARD_COST_RATIO
    });
  });

  it("is issued as a gift worth its price, which is what it saves the member", () => {
    const p = fresh();
    const n = middle(p);
    const issue = issueAt(special(p, n, libre("Manicura de regalo", 24.5)), n);

    expect(issue).toEqual({
      kind: "PREMIO",
      title: "Manicura de regalo",
      detail: { items: [], value: 24.5 }
    });
    expect(giftSaving(MemberRewardKind.PREMIO, issue.detail, {})).toEqual({
      kind: "GIFT",
      cents: 2450
    });
  });

  it("shows its price to the admin as the reward's value", () => {
    const p = fresh();
    const n = middle(p);
    const shown = presentedAt(special(p, n, libre("Manicura de regalo", 24.5)), n);

    expect(shown.reward).toMatchObject({ name: "Manicura de regalo", kind: "libre", items: [] });
    expect(shown.reward).not.toHaveProperty("description");
    expect(shown.rewardValueEuro).toBe(25);
  });

  it("keeps the text when a label written over it is restored", () => {
    const p = fresh();
    const n = middle(p);
    const withText = special(p, n, libre("Manicura de regalo", 24.5));
    const labelled = applyTexts(withText, { rewards: [{ milestone: n, label: "Otra cosa" }] });

    if (!labelled.ok) throw new Error(labelled.reason);

    expect(issueAt(labelled.program, n).title).toBe("Otra cosa");

    const restored = applyTexts(labelled.program, { rewards: [{ milestone: n, label: null }] });

    if (!restored.ok) throw new Error(restored.reason);

    expect(issueAt(restored.program, n).title).toBe("Manicura de regalo");
  });

  it("refuses an empty text and a price that is not above zero", () => {
    const p = fresh();
    const n = middle(p);

    expect(swapRewardToSpecial(p, ANSWERS, n, libre("   ", 10))).toEqual({
      ok: false,
      reason: FREE_REWARD_REFUSALS.name
    });

    for (const price of [0, -5, Number.NaN]) {
      expect(swapRewardToSpecial(p, ANSWERS, n, libre("Manicura", price))).toEqual({
        ok: false,
        reason: FREE_REWARD_REFUSALS.price
      });
    }
  });
});

describe("switching between kinds", () => {
  it("never offers a special reward back as an empty alternative", () => {
    const p = fresh();
    const n = middle(p);
    const before = entry(p, n);
    const doble = special(p, n, { kind: "doble" });

    // The catalogue reward it replaced is offered back, as with any swap.
    expect(entry(doble, n).alts[0]).toEqual(before.o);

    const libre = special(doble, n, { kind: "libre", name: "Manicura", priceEuro: 20 });

    expect(entry(libre, n).alts.every((a) => a.items.length > 0)).toBe(true);
  });

  it("clears the special reward when a catalogue item is chosen again", () => {
    const p = fresh();
    const n = middle(p);
    const itemId = p.chosen[0].o.items[0].id;
    const back = swapRewardToItem(special(p, n, { kind: "doble" }), ANSWERS, n, itemId);

    if (!back.ok) throw new Error(back.reason);

    expect(entry(back.program, n).special).toBeUndefined();
    expect(entry(back.program, n).o.items.map((i) => i.id)).toEqual([itemId]);
    expect(issueAt(back.program, n).kind).toBe("PREMIO");
  });

  it("re-derives the cost, and leaves every other reward and the given programme as they were", () => {
    const p = fresh();
    const n = middle(p);
    const snapshot = JSON.stringify(p);
    const next = special(p, n, { kind: "doble" });

    expect(JSON.stringify(p)).toBe(snapshot);
    expect(next.totalCost).toBeCloseTo(
      next.chosen.reduce((s, c) => s + c.o.cost, 0) + next.perkCost,
      10
    );
    expect(next.costPct).toBeCloseTo(next.totalCost / next.diamondReal, 10);

    for (const c of p.chosen.filter((x) => x.m.n !== n)) {
      expect(entry(next, c.m.n).o).toEqual(c.o);
      expect(entry(next, c.m.n).special).toBeUndefined();
    }
  });

  it("refuses a milestone that holds no reward", () => {
    const p = fresh();
    const perk = p.lad.ms.find((m) => m.type === "ventaja")!.n;

    expect(swapRewardToSpecial(p, ANSWERS, perk, { kind: "doble" })).toMatchObject({ ok: false });
  });
});

describe("what kind a reward is, for the screen's icon", () => {
  const option = (...cats: Array<"COS" | "FAC">) => ({
    items: cats.map((cat, i) => ({ id: `I${i}`, name: `I${i}`, cat, value: 10, cost: 2 })),
    value: 10 * cats.length,
    cost: 2 * cats.length
  });

  it("is a product only when every item is retail, a treatment otherwise", () => {
    expect(rewardKindOf({ o: option("COS") })).toBe("producto");
    expect(rewardKindOf({ o: option("COS", "COS") })).toBe("producto");
    expect(rewardKindOf({ o: option("FAC") })).toBe("tratamiento");
    expect(rewardKindOf({ o: option("COS", "FAC") })).toBe("tratamiento");
  });

  it("is the special kind when there is one", () => {
    for (const kind of ["doble", "sorpresa", "libre"] as const) {
      expect(rewardKindOf({ o: option(), special: { kind, name: "x", desc: "" } })).toBe(kind);
    }
  });

  it("is on every reward of the presented ladder", () => {
    const shown = presentProgram(fresh()).ladder.filter((m) => m.type === "premio");

    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((m) => ["tratamiento", "producto"].includes(m.reward!.kind))).toBe(true);
  });
});

describe("the note that rewards cannot rise from one milestone to the next", () => {
  it("is information for the admin, and never blocks publishing", () => {
    expect(blockingReview([ORDER_REVIEW_NOTE])).toEqual([]);
    expect(informationalNotes([ORDER_REVIEW_NOTE])).toEqual([ORDER_REVIEW_NOTE]);

    const other = "Hay 1 fila del catálogo sin categoría. Clasifícalas en la tabla.";

    expect(blockingReview([ORDER_REVIEW_NOTE, other])).toEqual([other]);
  });

  it("moves from the blocking list to the admin's notes, and the centre sees neither", () => {
    const p = { ...fresh(), review: [ORDER_REVIEW_NOTE] };

    expect(presentProgram(p, { forAdmin: true })).toMatchObject({
      review: [],
      notes: [ORDER_REVIEW_NOTE]
    });
    expect(presentProgram(p)).toMatchObject({ review: [], notes: [] });
  });
});
