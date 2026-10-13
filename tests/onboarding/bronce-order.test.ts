import { describe, expect, it } from "vitest";

import { orderBronce } from "../../src/modules/onboarding/engine";
import type {
  Candidate,
  ChosenReward,
  Milestone,
  RewardOption
} from "../../src/modules/onboarding/engine.types";

/**
 * The Bronce ordering rule, in isolation.
 *
 * The guide asks for two things that can contradict each other: Bronce's best reward goes
 * first, and no gift repeats in two milestones in a row. These build the situations by
 * hand rather than hoping a catalogue produces them, because the interesting branches —
 * the second attempt and the fallback — are ones the Sapphira fixture never reaches.
 */

const item = (id: string): Candidate => ({ id, name: id, cat: "COS", value: 10, cost: 5 });

const option = (value: number, ...itemIds: string[]): RewardOption => ({
  items: itemIds.map(item),
  value,
  cost: value / 2
});

const milestone = (n: number, tramo: number): Milestone => ({
  n,
  tramo,
  type: "premio",
  th: n * 10,
  cb: 10,
  cap: 12,
  V: 20
});

/** Segment 1 holds the first three; `later` are the rewards after it. */
const ladder = (bronce: RewardOption[], ...later: RewardOption[]): ChosenReward[] => [
  ...bronce.map((o, i) => ({ m: milestone(i + 1, 1), o, alts: [] as RewardOption[] })),
  ...later.map((o, i) => ({
    m: milestone(bronce.length + i + 1, 2),
    o,
    alts: [] as RewardOption[]
  }))
];

const idsOf = (chosen: ChosenReward[]): string[] =>
  chosen.slice(0, 3).map((c) => c.o.items.map((i) => i.id).join("+"));

describe("orderBronce", () => {
  it("moves the best reward first and keeps the rest ascending, as the guide says", () => {
    const chosen = ladder([option(10, "a"), option(20, "b"), option(30, "c")], option(40, "d"));

    expect(orderBronce(chosen)).toBe("best-first");
    expect(idsOf(chosen)).toEqual(["c", "a", "b"]);
    expect(chosen.slice(0, 3).map((c) => c.o.value)).toEqual([30, 10, 20]);
  });

  it("leaves a tied segment alone, because there is no best to move", () => {
    // The production case. All three Bronce rewards are worth 20, so "best first" means
    // nothing — and the rotation the reference applies anyway is what creates the repeat.
    const chosen = ladder([option(20, "a"), option(20, "b"), option(20, "c")], option(30, "d"));

    expect(orderBronce(chosen)).toBe("unchanged");
    expect(idsOf(chosen)).toEqual(["a", "b", "c"]);
  });

  it("does nothing when the first reward already is a best one", () => {
    const chosen = ladder([option(30, "a"), option(10, "b"), option(20, "c")], option(40, "d"));

    expect(orderBronce(chosen)).toBe("unchanged");
    expect(idsOf(chosen)).toEqual(["a", "b", "c"]);
  });

  it("reproduces the reference's defect, then avoids it", () => {
    // Beam order a,b,c has no adjacent repeat. The rotation c,a,b puts c next to a, and
    // they share "x" — exactly how the reference breaks its own guarantee.
    const chosen = ladder(
      [option(10, "a", "x"), option(20, "b"), option(30, "c", "x")],
      option(40, "d")
    );

    const outcome = orderBronce(chosen);

    expect(outcome).toBe("best-first-descending");
    // c first, then b, then a: x is no longer adjacent to itself.
    expect(idsOf(chosen)).toEqual(["c+x", "b", "a+x"]);
  });

  it("checks the boundary with the next segment, not just inside Bronce", () => {
    // The rotation ends on b, and b shares "y" with the first reward of segment 2. The
    // beam never checked that pairing because b was not last in its own order.
    const chosen = ladder(
      [option(10, "a"), option(20, "b", "y"), option(30, "c")],
      option(40, "d", "y")
    );

    const outcome = orderBronce(chosen);

    expect(outcome).toBe("best-first-descending");
    expect(idsOf(chosen)).toEqual(["c", "b+y", "a"]);
    // ...which leaves a, not b, adjacent to segment 2.
    const sequence = [...chosen.map((c) => c.o.items.map((i) => i.id))];
    for (let i = 1; i < sequence.length; i += 1) {
      expect(sequence[i].some((id) => sequence[i - 1].includes(id))).toBe(false);
    }
  });

  it("keeps the beam's order when best-first cannot be had without a repeat", () => {
    // Both arrangements with c first collide: x ties a to c, y ties b to the next segment
    // and z ties a to it as well. The second guarantee wins and the order stands.
    const chosen = ladder(
      [option(10, "a", "x", "z"), option(20, "b", "y"), option(30, "c", "x", "y")],
      option(40, "d", "y", "z")
    );
    const before = idsOf(chosen);

    expect(orderBronce(chosen)).toBe("kept-to-avoid-repeat");
    expect(idsOf(chosen)).toEqual(before);
  });

  it("moves a reward together with its alternatives", () => {
    // Alternatives were computed against a reward's neighbours, so they must travel with
    // it — otherwise a swap offered to the centre could break the ladder's ordering.
    const alt = option(25, "alt");
    const chosen = ladder([option(10, "a"), option(20, "b"), option(30, "c")], option(40, "d"));
    chosen[2].alts = [alt];

    orderBronce(chosen);

    expect(chosen[0].o.items[0].id).toBe("c");
    expect(chosen[0].alts).toEqual([alt]);
    expect(chosen[1].alts).toEqual([]);
  });

  it("never touches a later segment", () => {
    const chosen = ladder(
      [option(10, "a"), option(20, "b"), option(30, "c")],
      option(40, "d"),
      option(50, "e"),
      option(60, "f")
    );

    orderBronce(chosen);

    expect(chosen.slice(3).map((c) => c.o.items[0].id)).toEqual(["d", "e", "f"]);
  });

  it("copes with a ladder that has no later segment", () => {
    const chosen = ladder([option(10, "a"), option(20, "b"), option(30, "c")]);

    expect(orderBronce(chosen)).toBe("best-first");
  });
});
