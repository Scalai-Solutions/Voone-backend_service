import { describe, expect, it } from "vitest";

import { CATEGORIES } from "../../src/modules/onboarding/engine.config";
import {
  candidates,
  classify,
  isGiftable,
  manualCandidates,
  run
} from "../../src/modules/onboarding/engine";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { swapRewardToItem } from "../../src/modules/onboarding/swap";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * The admin's own choice of reward ("Cambiar" > "O cualquier artículo del catálogo") may be any
 * treatment or product, waxing and diagnostics included; only prescription and medical items
 * stay out. That is a wider rule than the one the engine proposes from, which these tests also
 * pin: the automatic proposals must not move.
 */
const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const items = (extra: CatalogItem[] = []): CatalogItem[] => [
  ...(catalog as CatalogItem[]),
  ...extra
];

const fresh = (extra: CatalogItem[] = []): Program => {
  const result = run(items(extra), ANSWERS);

  if (isEngineError(result)) throw new Error(result.error);

  return result;
};

const entry = (p: Program, n: number) => p.chosen.find((c) => c.m.n === n)!;
const swap = (p: Program, n: number, id: string) => swapRewardToItem(p, ANSWERS, n, id);
const ok = (r: ReturnType<typeof swap>): Program => {
  if (!r.ok) throw new Error(r.reason);

  return r.program;
};
const reason = (r: ReturnType<typeof swap>): string => (r.ok ? "" : r.reason);

describe("manual eligibility per category", () => {
  it("is explicit on every category and excludes exactly the medical ones", () => {
    for (const [code, cfg] of Object.entries(CATEGORIES)) {
      expect(typeof cfg.manualReward, code).toBe("boolean");
    }

    const blocked = Object.entries(CATEGORIES)
      .filter(([, cfg]) => !cfg.manualReward)
      .map(([code]) => code)
      .sort();

    expect(blocked).toEqual(["MFA", "MNF"]);
  });

  it("is never narrower than the engine's own rule", () => {
    for (const [code, cfg] of Object.entries(CATEGORIES)) {
      if (cfg.reward) expect(cfg.manualReward, code).toBe(true);
    }
  });

  it("leaves the engine's own rule where it was: waxing and diagnosis still are not proposed", () => {
    expect(CATEGORIES.CER.reward).toBe(false);
    expect(CATEGORIES.DIA.reward).toBe(false);
  });
});

describe("manualCandidates", () => {
  const cls = classify(items());
  const ids = (list: Array<{ id: string }>) => list.map((c) => c.id);

  it("adds waxing and diagnosis to what the engine proposes, and nothing medical", () => {
    const auto = ids(candidates(cls, ANSWERS));
    const manual = ids(manualCandidates(cls, ANSWERS));

    for (const id of auto) expect(manual).toContain(id);

    const extra = manual.filter((id) => !auto.includes(id)).sort();

    expect(extra).toEqual(["C5", "F5", "L1", "W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"]);
    // 22 of 45 Sapphira rows cannot be a manual reward: nine MFA, two MNF is the legal block;
    // the rest of the 22 (9 CER + 2 DIA) are now allowed, leaving the 11 medical ones.
    expect(cls.length - manual.length).toBe(11);
  });

  it("prices a candidate exactly as the engine does", () => {
    const wax = manualCandidates(cls, ANSWERS).find((c) => c.id === "W3")!;
    const dia = manualCandidates(cls, ANSWERS).find((c) => c.id === "C5")!;

    expect(wax).toMatchObject({ value: 23, cat: "CER" });
    expect(wax.cost).toBeCloseTo(23 * 0.15, 10);
    expect(dia).toMatchObject({ value: 5, cat: "DIA", cost: 0 });
  });

  it("never offers an item without a price or without a resolved category", () => {
    const odd = classify([
      { id: "FREE", name: "Cera de cortesía", price: 0 },
      { id: "WHO", name: "Servicio sin nombre reconocible", price: 40 }
    ]);

    expect(manualCandidates(odd, ANSWERS)).toEqual([]);
  });

  it("flags giftable with the same rule", () => {
    const odd = classify([
      { id: "FREE", name: "Cera de cortesía", price: 0 },
      { id: "WHO", name: "Servicio sin nombre reconocible", price: 40 },
      { id: "WAX", name: "Cera ingles", price: 18 },
      { id: "BOT", name: "Botox", price: 200 }
    ]);

    expect(odd.map((i) => [i.id, isGiftable(i)])).toEqual([
      ["FREE", false],
      ["WHO", false],
      ["WAX", true],
      ["BOT", false]
    ]);

    // The flag and the swap's list can never disagree.
    const all = classify(items());

    expect(all.filter(isGiftable).map((i) => i.id)).toEqual(
      manualCandidates(all, ANSWERS).map((c) => c.id)
    );
  });
});

describe("swapRewardToItem with the wider rule", () => {
  it("accepts a waxing item on a draft", () => {
    // Milestone 3 sits in Bronce (worth 10); the wax is worth 10 as well.
    const next = ok(swap(fresh(), 3, "W8"));

    expect(entry(next, 3).o.items.map((i) => i.id)).toEqual(["W8"]);
    expect(Number.isFinite(next.costPct)).toBe(true);
  });

  it("accepts a 5 euro diagnosis in Bronce, where it costs nothing and raises no flag", () => {
    const p = fresh();
    const next = ok(swap(p, 3, "C5"));

    expect(entry(next, 3).o).toMatchObject({ value: 5, cost: 0 });
    expect(Number.isFinite(next.totalCost)).toBe(true);
    expect(Number.isFinite(next.costPct)).toBe(true);
    expect(next.costPct).toBeLessThan(p.costPct);
    expect(next.review).toEqual(p.review);
    expect(next.guarantees.every(([, held]) => typeof held === "boolean")).toBe(true);
  });

  it("refuses the same 5 euro diagnosis in a later tier, naming the milestone, not a number gone wrong", () => {
    const r = swap(fresh(), 7, "C5");

    expect(r.ok).toBe(false);
    expect(reason(r)).toContain("hito 7");
    expect(reason(r)).toContain("menos valor");
  });

  it("accepts a dearer-than-neighbours diagnosis in a later tier, at zero cost", () => {
    const p = fresh([{ id: "DX", name: "Diagnóstico integral", price: 33 }]);
    const next = ok(swap(p, 9, "DX"));

    expect(entry(next, 9).o).toMatchObject({ value: 33, cost: 0 });
    expect(Number.isNaN(next.costPct)).toBe(false);
    expect(next.costPct).toBeLessThan(p.costPct);
    expect(next.review).not.toContain(
      "El coste de los premios supera en más de un 50% la inversión elegida. Sube la inversión o añade regalos más baratos."
    );
  });

  it("accepts a waxing item in a later tier and keeps the cost note in step", () => {
    const p = fresh();
    const next = ok(swap(p, 9, "W3"));

    expect(entry(next, 9).o.items[0].id).toBe("W3");
    expect(entry(next, 9).o.cost).toBeCloseTo(23 * 0.15, 10);
    expect(Number.isFinite(next.costPct)).toBe(true);
  });

  it("flags a waxing item that makes the programme too dear, instead of refusing it", () => {
    const p = fresh([{ id: "WX", name: "Cera lujo corporal", price: 2000 }]);
    const next = ok(swap(p, 22, "WX"));

    expect(Number.isFinite(next.costPct)).toBe(true);
    expect(next.review.some((n) => n.startsWith("El coste de los premios supera"))).toBe(true);
  });

  it("refuses a pharmacological and a medical item with the medical sentence", () => {
    const p = fresh();

    // M1 is Ácido hialurónico (MFA), M10 a consulta médica (MNF).
    for (const id of ["M1", "M10"]) {
      expect(swap(p, 3, id)).toEqual({
        ok: false,
        reason: "Los tratamientos y productos médicos no se pueden dar como premio."
      });
    }
  });

  it("refuses an item with no category, and says what to do", () => {
    const p = fresh([{ id: "WHO", name: "Servicio sin nombre reconocible", price: 12 }]);

    expect(swap(p, 3, "WHO")).toEqual({
      ok: false,
      reason: "Asigna una categoría a este artículo en el catálogo antes de usarlo como premio."
    });
  });

  it("refuses an item with no price, and an item that is not in the catalogue", () => {
    const p = fresh([{ id: "FREE", name: "Cera de cortesía", price: 0 }]);

    expect(swap(p, 3, "FREE")).toEqual({
      ok: false,
      reason: "Ese artículo no tiene precio, así que no puede ser un premio."
    });
    expect(swap(p, 3, "no-such-item")).toEqual({
      ok: false,
      reason: "Ese artículo no está en el catálogo."
    });
  });

  it("names the milestones when a swap would repeat a gift in a row", () => {
    const p = fresh();
    const neighbour = entry(p, 5).o.items[0].id;
    const r = swap(p, 3, neighbour);

    expect(reason(r)).toContain("repetiría un regalo en dos hitos seguidos");
    expect(reason(r)).toContain("hitos 3 y 5");
  });
});

describe("the engine's own output does not move", () => {
  it("still never proposes a wax or a diagnosis, whatever the answers", () => {
    for (const objective of ["equilibrado", "mas_gasto"] as const) {
      const p = run(items(), { ...ANSWERS, objective });

      if (isEngineError(p)) throw new Error(p.error);

      const used = p.chosen.flatMap((c) =>
        [c.o, ...c.alts].flatMap((o) => o.items.map((i) => i.cat))
      );

      expect(used.filter((c) => c === "CER" || c === "DIA")).toEqual([]);
    }
  });
});
