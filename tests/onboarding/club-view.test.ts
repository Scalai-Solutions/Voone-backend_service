import { describe, expect, it } from "vitest";

import { clubView } from "../../src/modules/onboarding/club-view";
import { run } from "../../src/modules/onboarding/engine";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { applyBenefitOverrides } from "../../src/modules/onboarding/benefit-lines";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * The public club page's view of a programme. It is a projection of presentProgram, so these tests
 * pin what must hold whatever the page does: it is what the card says, it carries no cost or
 * retail value, and a tier shows only what a client may read.
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

describe("club view", () => {
  it("lists the five tiers in order, each with at least one benefit", () => {
    const club = clubView(fresh());

    expect(club.tiers.map((t) => t.label)).toEqual([
      "Bronce",
      "Plata",
      "Oro",
      "Platino",
      "Diamante"
    ]);

    for (const tier of club.tiers) expect(tier.benefits.length).toBeGreaterThan(0);
  });

  it("shows exactly the visible lines the wallet card reads", () => {
    const program = fresh();
    const hidden = applyBenefitOverrides(program, "oro", [{ key: "tests", hidden: true }]);

    if (!hidden.ok) throw new Error(hidden.reason);

    const oro = clubView(hidden.program).tiers.find((t) => t.key === "oro")!;

    expect(oro.benefits.map((b) => b.text).some((text) => /nuevos tratamientos/i.test(text))).toBe(
      false
    );
  });

  it("puts no badge on the first tier and badges only generated lines that change upward", () => {
    const club = clubView({ ...fresh(), customBenefits: { plata: ["Café de cortesía"] } });

    expect(club.tiers[0].benefits.every((b) => b.badge === undefined)).toBe(true);

    const plata = club.tiers[1];

    expect(plata.benefits.find((b) => b.text === "Café de cortesía")?.badge).toBeUndefined();
    expect(plata.benefits.some((b) => b.badge === "new")).toBe(true);
  });

  it("marks a line that exists in the tier below with different words as an upgrade", () => {
    const club = clubView(fresh());
    const gold = club.tiers.find((t) => t.key === "oro")!;

    // The discount is in Plata too, at a lower rate.
    const discount = gold.benefits.find((b) => /^Descuento del/.test(b.text));

    expect(discount?.badge).toBe("up");
  });

  it("groups the ladder by the tier a client is in, without tier-up rows, in order", () => {
    const club = clubView(fresh());

    expect(club.ladder.length).toBeGreaterThan(0);
    expect(club.ladder.map((g) => g.tierLabel)).not.toContain("Diamante");

    for (const group of club.ladder) {
      expect(group.steps.length).toBeGreaterThan(0);

      for (const step of group.steps) {
        expect(step.title.length).toBeGreaterThan(0);
        expect(step.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("carries the referral rewards, the welcome progress and the recurring reward", () => {
    const program = fresh();
    const club = clubView(program);

    expect(club.referrals.length).toBeGreaterThan(0);
    expect(club.referrals.map((r) => r.n)).toEqual(
      [...club.referrals.map((r) => r.n)].sort((a, b) => a - b)
    );
    expect(club.welcome).toBe(program.welcome);
    expect(club.recurring.every).toBeGreaterThan(0);
    expect(club.recurring.name.length).toBeGreaterThan(0);
  });

  it("never carries a cost, a price or a retail value, at any depth", () => {
    const keys = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        for (const [key, child] of Object.entries(node)) {
          keys.add(key);
          walk(child);
        }
      }
    };

    walk(clubView(fresh()));

    for (const key of keys) {
      expect(key).not.toMatch(/cost|coste|price|precio|value|valor|revenue|budget|kind/i);
    }
  });
});
