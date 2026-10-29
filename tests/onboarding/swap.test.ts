import { describe, expect, it } from "vitest";

import { COST_REVIEW_NOTE, run } from "../../src/modules/onboarding/engine";
import type {
  Answers,
  CatalogItem,
  Candidate,
  Program,
  RewardOption
} from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { swapReward } from "../../src/modules/onboarding/swap";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * Swapping a reward, which is where a valid programme can be made invalid.
 *
 * The real Sapphira programme offers alternatives at three milestones (7, 17 and 22), so those
 * are exercised as they are. The rules a swap must REFUSE — a repeat, a falling ladder, a
 * broken Bronce — cannot be reached with the alternatives the engine itself proposes, because
 * it proposes only safe ones; so those are built by planting an unsafe alternative and
 * checking the swap catches it. A refusal that was never provoked would be an assumption.
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

const candidate = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  name: id,
  cat: "COS",
  value: 10,
  cost: 5,
  ...over
});

const option = (value: number, cost: number, ...itemIds: string[]): RewardOption => ({
  items: itemIds.map((id) => candidate(id, { value: value / itemIds.length })),
  value,
  cost
});

const entry = (p: Program, n: number) => p.chosen.find((c) => c.m.n === n)!;
const idsOf = (o: RewardOption): string => o.items.map((i) => i.id).join("+");

describe("swapReward, with the alternatives the engine proposes", () => {
  it("puts the alternative in the slot and returns the old reward as an alternative", () => {
    const p = fresh();
    const before = idsOf(entry(p, 7).o);
    const result = swapReward(p, ANSWERS, 7, 0);

    expect(result.ok).toBe(true);

    const next = (result as { program: Program }).program;

    expect(idsOf(entry(next, 7).o)).toBe("P2");
    // So the centre can undo it.
    expect(entry(next, 7).alts.map(idsOf)).toContain(before);
  });

  it("does not touch the programme it was given", () => {
    const p = fresh();
    const snapshot = JSON.stringify(p);

    swapReward(p, ANSWERS, 7, 0);

    expect(JSON.stringify(p)).toBe(snapshot);
  });

  it("leaves every other reward exactly where it was", () => {
    const p = fresh();
    const next = (swapReward(p, ANSWERS, 7, 0) as { program: Program }).program;

    for (const c of p.chosen.filter((x) => x.m.n !== 7)) {
      expect(idsOf(entry(next, c.m.n).o)).toBe(idsOf(c.o));
    }
  });

  it("recomputes the cost and the guarantees, because they depend on what was swapped", () => {
    const p = fresh();
    const next = (swapReward(p, ANSWERS, 7, 0) as { program: Program }).program;
    const expected = next.chosen.reduce((s, c) => s + c.o.cost, 0) + next.perkCost;

    expect(next.totalCost).toBeCloseTo(expected, 10);
    expect(next.costPct).toBeCloseTo(next.totalCost / next.diamondReal, 10);
    // The guarantee's own sentence quotes the percentage, so it must have been rebuilt.
    expect(next.guarantees.some(([text]) => text.includes("cuestan el"))).toBe(true);
  });

  it("re-picks the recurring reward when the last ladder reward overtakes it", () => {
    // Milestone 22 is the last reward, worth 80, and its alternatives are worth 90. The
    // recurring reward must be worth at least the last one, so it cannot stay at 80.
    const p = fresh();

    expect(p.rec.o.value).toBe(80);

    const next = (swapReward(p, ANSWERS, 22, 0) as { program: Program }).program;

    expect(entry(next, 22).o.value).toBe(90);
    expect(next.rec.o.value).toBeGreaterThanOrEqual(90);
  });

  it("leaves the recurring reward alone when a middle reward is swapped", () => {
    const p = fresh();
    const next = (swapReward(p, ANSWERS, 17, 0) as { program: Program }).program;

    expect(next.rec).toEqual(p.rec);
  });
});

describe("swapReward, refusing what it must", () => {
  it("refuses a milestone that has no reward to swap", () => {
    // 2 is a perk, 4 is a tier-up.
    expect(swapReward(fresh(), ANSWERS, 2, 0)).toMatchObject({ ok: false });
    expect(swapReward(fresh(), ANSWERS, 4, 0)).toMatchObject({ ok: false });
    expect(swapReward(fresh(), ANSWERS, 999, 0)).toMatchObject({ ok: false });
  });

  it("refuses an alternative that does not exist", () => {
    expect(swapReward(fresh(), ANSWERS, 7, 5)).toMatchObject({
      ok: false,
      reason: "Esa alternativa no existe."
    });
    expect(swapReward(fresh(), ANSWERS, 9, 0)).toMatchObject({ ok: false });
  });

  it("refuses a swap that would repeat a gift in two milestones in a row", () => {
    const p = fresh();
    const neighbour = entry(p, 9);

    // Plant an alternative at 9 that shares an item with the reward at 7.
    neighbour.alts = [option(neighbour.o.value, 5, ...p.chosen[3].o.items.map((i) => i.id))];

    expect(swapReward(p, ANSWERS, 9, 0)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Ese cambio repetiría un regalo en dos hitos seguidos")
    });
  });

  it("refuses a swap that would drop a reward below the one before it", () => {
    const p = fresh();

    // Milestone 9 follows 7 (worth 20). An alternative worth 5 would fall below it.
    entry(p, 9).alts = [option(5, 1, "TINY")];

    expect(swapReward(p, ANSWERS, 9, 0)).toMatchObject({
      ok: false,
      reason: "Ese cambio dejaría el premio del hito 9 con menos valor que el del hito 7."
    });
  });

  it("refuses a swap that stops Bronce leading with its best reward", () => {
    const p = fresh();
    const first = entry(p, 1);

    // 1 is worth 18, the best in Bronce. An alternative worth 4 would no longer lead.
    first.alts = [option(4, 1, "TINY")];

    expect(swapReward(p, ANSWERS, 1, 0)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Bronce")
    });
  });

  it("does not block on a Bronce rule the programme already could not hold", () => {
    // A programme whose Bronce ordering was already given up (and said so) must not trap the
    // centre: the swap is not what broke it.
    const p = fresh();
    p.guarantees = p.guarantees.map(([text, held]) =>
      text === "En Bronce el mejor premio es el primero" ? [text, false] : [text, held]
    );
    entry(p, 1).alts = [option(4, 1, "TINY")];

    expect(swapReward(p, ANSWERS, 1, 0)).toMatchObject({ ok: true });
  });
});

describe("swapReward and the other alternatives", () => {
  it("removes alternatives elsewhere that would now put an item in the ladder twice", () => {
    const p = fresh();
    const taken = entry(p, 7).alts[0].items[0].id; // P2, the item about to be used at 7

    // Plant an alternative at 17 that also uses P2.
    entry(p, 17).alts = [option(70, 5, taken), ...entry(p, 17).alts];

    const next = (swapReward(p, ANSWERS, 7, 0) as { program: Program }).program;

    expect(entry(next, 17).alts.some((a) => a.items.some((i) => i.id === taken))).toBe(false);
  });

  it("keeps at most two alternatives per milestone", () => {
    const p = fresh();
    const next = (swapReward(p, ANSWERS, 22, 0) as { program: Program }).program;

    expect(entry(next, 22).alts.length).toBeLessThanOrEqual(2);
  });
});

describe("swapReward and cost", () => {
  it("lets a dearer choice through but raises the blocking note, so it is never silent", () => {
    const p = fresh();

    // Worth the same and legitimate, but far dearer for the centre.
    entry(p, 7).alts = [option(entry(p, 7).o.value + 1, 5000, "PRICEY")];

    const result = swapReward(p, ANSWERS, 7, 0);

    expect(result.ok).toBe(true);

    const next = (result as { program: Program }).program;

    expect(next.review).toContain(COST_REVIEW_NOTE);
    expect(next.guarantees.find(([t]) => t.startsWith("Premios y ventajas cuestan"))![1]).toBe(
      false
    );
  });

  it("clears the note again when the change is undone", () => {
    const p = fresh();

    entry(p, 7).alts = [option(entry(p, 7).o.value + 1, 5000, "PRICEY")];

    const dear = (swapReward(p, ANSWERS, 7, 0) as { program: Program }).program;
    // The original reward is now the first alternative.
    const back = swapReward(dear, ANSWERS, 7, 0);

    expect(back.ok).toBe(true);
    expect((back as { program: Program }).program.review).not.toContain(COST_REVIEW_NOTE);
  });

  it("never duplicates the note", () => {
    const p = fresh();

    p.review = [COST_REVIEW_NOTE];
    entry(p, 7).alts = [option(entry(p, 7).o.value + 1, 5000, "PRICEY")];

    const next = (swapReward(p, ANSWERS, 7, 0) as { program: Program }).program;

    expect(next.review.filter((n) => n === COST_REVIEW_NOTE)).toHaveLength(1);
  });
});
