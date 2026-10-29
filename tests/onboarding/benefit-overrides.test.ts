import { describe, expect, it } from "vitest";

import { run } from "../../src/modules/onboarding/engine";
import { TIERS } from "../../src/modules/onboarding/engine.config";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { applyBenefitOverrides } from "../../src/modules/onboarding/benefit-lines";
import { benefitOverridesSchema } from "../../src/modules/onboarding/onboarding.schema";
import { presentProgram } from "../../src/modules/onboarding/presentation";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * Display-only overrides of the lines the engine generates for a tier.
 *
 * Pure tests. They pin what must hold whatever the screen does: every generated line has a stable
 * key that no other line of its tier shares, an override only ever changes text or visibility, the
 * `benefits` strings (what the card and the pass read) are exactly the visible lines, and with no
 * overrides nothing about a tier changes.
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

const tierOf = (program: Program, key: string) =>
  presentProgram(program).tiers.find((t) => t.key === key)!;

const ok = (
  program: Program,
  tier: (typeof TIERS)[number],
  entries: Parameters<typeof applyBenefitOverrides>[2]
): Program => {
  const result = applyBenefitOverrides(program, tier, entries);

  if (!result.ok) throw new Error(result.reason);

  return result.program;
};

describe("benefit lines: keys", () => {
  it("gives every generated line a key no other line of its tier shares", () => {
    const program = { ...fresh(), customBenefits: { oro: ["Café", "Parking"] } };

    for (const tier of presentProgram(program).tiers) {
      const keys = tier.benefitLines.map((l) => l.key);

      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.every((k) => k.length > 0)).toBe(true);
    }
  });

  it("derives the key from what the line is, in the engine's own order", () => {
    const program = fresh();
    const keysOf = (key: string) =>
      tierOf(program, key)
        .benefitLines.filter((l) => l.kind === "generated")
        .map((l) => l.key);

    expect(keysOf("bronce")).toEqual(["birthday", "card"]);
    expect(keysOf("plata")).toEqual(["discount", "birthday", "priority"]);
    expect(keysOf("oro")).toEqual(["mult", "discount", "birthday", "tests", "happyhour"]);
    expect(keysOf("platino")).toEqual([
      "mult",
      "discount",
      "birthday",
      "events",
      "tests",
      "happyhour",
      "access48"
    ]);
    expect(keysOf("diamante")).toEqual([
      "mult",
      "discount",
      "birthday",
      "events",
      "tests",
      "happyhour",
      "guaranteed48",
      "plan"
    ]);
  });

  it("numbers the lines the clinic added as custom:<index>", () => {
    const program = { ...fresh(), customBenefits: { plata: ["Uno", "Dos"] } };
    const custom = tierOf(program, "plata").benefitLines.filter((l) => l.kind === "custom");

    expect(custom.map((l) => [l.key, l.text])).toEqual([
      ["custom:0", "Uno"],
      ["custom:1", "Dos"]
    ]);
    expect(custom.every((l) => !l.edited && !l.hidden && l.original === l.text)).toBe(true);
  });
});

describe("benefit lines: without overrides", () => {
  it("leaves `benefits` exactly as the engine and the clinic wrote them", () => {
    const program = { ...fresh(), customBenefits: { oro: ["Café"] } };

    for (const tier of presentProgram(program).tiers) {
      expect(tier.benefits).toEqual(tier.benefitLines.map((l) => l.text));
      expect(tier.benefitLines.every((l) => !l.edited && !l.hidden)).toBe(true);
    }

    expect(tierOf(program, "oro").benefits[0]).toBe("Cada euro suma ×1,1 de progreso");
    expect(tierOf(program, "oro").benefits.at(-1)).toBe("Café");
  });
});

describe("applyBenefitOverrides", () => {
  it("replaces the text of a generated line, keeping the original to show and restore", () => {
    const p = fresh();
    const before = tierOf(p, "plata");
    const next = ok(p, "plata", [{ key: "discount", text: "Un 3% menos en cosmética" }]);
    const after = tierOf(next, "plata");
    const line = after.benefitLines.find((l) => l.key === "discount")!;

    expect(line).toMatchObject({
      text: "Un 3% menos en cosmética",
      original: before.benefitLines.find((l) => l.key === "discount")!.text,
      kind: "generated",
      edited: true,
      hidden: false
    });
    expect(after.benefits).toContain("Un 3% menos en cosmética");
    expect(after.benefits).toHaveLength(before.benefits.length);
    // The line stays where it was.
    expect(after.benefitLines.map((l) => l.key)).toEqual(before.benefitLines.map((l) => l.key));
  });

  it("hides a line from `benefits` but keeps it in `benefitLines`, flagged", () => {
    const p = fresh();
    const before = tierOf(p, "oro");
    const next = ok(p, "oro", [{ key: "tests", hidden: true }]);
    const after = tierOf(next, "oro");
    const hidden = after.benefitLines.find((l) => l.key === "tests")!;

    expect(hidden).toMatchObject({ hidden: true, edited: false, text: hidden.original });
    expect(after.benefits).toEqual(before.benefits.filter((b) => b !== hidden.original));
    expect(after.benefitLines).toHaveLength(before.benefitLines.length);
  });

  it("keeps a hidden line's edit, so showing it again returns the edited text", () => {
    const p = fresh();
    const hiddenAndEdited = ok(p, "oro", [{ key: "tests", text: "Pruebas", hidden: true }]);
    const line = tierOf(hiddenAndEdited, "oro").benefitLines.find((l) => l.key === "tests")!;

    expect(line).toMatchObject({ text: "Pruebas", edited: true, hidden: true });

    const shown = ok(hiddenAndEdited, "oro", [{ key: "tests", text: "Pruebas", hidden: null }]);

    expect(tierOf(shown, "oro").benefits).toContain("Pruebas");
  });

  it("restores the original when the override is cleared", () => {
    const p = fresh();
    const original = tierOf(p, "oro");
    const edited = ok(p, "oro", [
      { key: "mult", text: "Más progreso" },
      { key: "tests", hidden: true }
    ]);
    const cleared = ok(edited, "oro", [
      { key: "mult" },
      { key: "tests", text: null, hidden: false }
    ]);

    expect(tierOf(cleared, "oro")).toEqual(original);
    expect(cleared.benefitOverrides?.oro ?? {}).toEqual({});
  });

  it("clears one aspect and keeps the other", () => {
    const p = fresh();
    const both = ok(p, "oro", [{ key: "tests", text: "Pruebas", hidden: true }]);
    const textOnly = ok(both, "oro", [{ key: "tests", text: "Pruebas", hidden: false }]);
    const hiddenOnly = ok(both, "oro", [{ key: "tests", text: null, hidden: true }]);

    expect(textOnly.benefitOverrides?.oro?.tests).toEqual({ text: "Pruebas" });
    expect(hiddenOnly.benefitOverrides?.oro?.tests).toEqual({ hidden: true });
  });

  it("does not store a text that equals the original", () => {
    const p = fresh();
    const original = tierOf(p, "plata").benefitLines.find((l) => l.key === "priority")!.original;
    const next = ok(p, "plata", [{ key: "priority", text: original }]);

    expect(next.benefitOverrides?.plata ?? {}).toEqual({});
    expect(tierOf(next, "plata").benefitLines.find((l) => l.key === "priority")!.edited).toBe(
      false
    );
  });

  it("only touches the tier and the keys it is given", () => {
    const p = fresh();
    const next = ok(p, "plata", [{ key: "discount", text: "X" }]);

    expect(tierOf(next, "oro")).toEqual(tierOf(p, "oro"));
    expect(tierOf(next, "plata").benefitLines.filter((l) => l.edited)).toHaveLength(1);
  });

  it("is display only: nothing but benefitOverrides changes in the programme", () => {
    const p = fresh();
    const next = ok(p, "diamante", [
      { key: "mult", hidden: true },
      { key: "discount", text: "Sin descuento" }
    ]);
    const { benefitOverrides, ...rest } = next;
    const { benefitOverrides: none, ...original } = p;

    expect(benefitOverrides).toBeDefined();
    expect(none).toBeUndefined();
    expect(rest).toEqual(original);
  });

  it("refuses a key the tier does not have, and stores nothing", () => {
    const p = fresh();
    const result = applyBenefitOverrides(p, "bronce", [
      { key: "birthday", text: "Bien" },
      { key: "discount", hidden: true }
    ]);

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/Ese beneficio no existe/) });
    expect(p.benefitOverrides).toBeUndefined();
  });

  it("points a custom line to the benefits route", () => {
    const p = { ...fresh(), customBenefits: { oro: ["Café"] } };
    const result = applyBenefitOverrides(p, "oro", [{ key: "custom:0", text: "Té" }]);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/añadiste tú/);
  });

  it("refuses the same key twice in one request", () => {
    const result = applyBenefitOverrides(fresh(), "oro", [
      { key: "mult", text: "A" },
      { key: "mult", hidden: true }
    ]);

    expect(result.ok).toBe(false);
  });

  it("does not mutate the programme it was given", () => {
    const p = fresh();
    const snapshot = structuredClone(p);

    ok(p, "oro", [{ key: "mult", hidden: true }]);

    expect(p).toEqual(snapshot);
  });
});

describe("benefitOverridesSchema", () => {
  const parse = (body: unknown) => benefitOverridesSchema.safeParse(body);

  it("accepts text, hidden, nulls and an empty entry", () => {
    expect(
      parse({
        overrides: [
          { key: "mult", text: "  Más  " },
          { key: "tests", hidden: true },
          { key: "discount", text: null, hidden: null },
          { key: "priority" }
        ]
      }).success
    ).toBe(true);
  });

  it("trims the text, and refuses blank, over 80, control characters and no entries", () => {
    const parsed = parse({ overrides: [{ key: "mult", text: "  Más  " }] });

    expect(parsed.success && parsed.data.overrides[0].text).toBe("Más");
    expect(parse({ overrides: [{ key: "mult", text: "   " }] }).success).toBe(false);
    expect(parse({ overrides: [{ key: "mult", text: "x".repeat(81) }] }).success).toBe(false);
    expect(parse({ overrides: [{ key: "mult", text: "a\nb" }] }).success).toBe(false);
    expect(parse({ overrides: [] }).success).toBe(false);
    expect(parse({}).success).toBe(false);
    expect(parse({ overrides: [{ text: "sin clave" }] }).success).toBe(false);
  });
});
