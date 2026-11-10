import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

// Settings of the original programme: this suite is not about the tuned ladder (tuning.test.ts is).
vi.mock("../../src/modules/onboarding/engine.config", async (importOriginal) => {
  const { referenceTuningMock } = await import("./reference-tuning");

  return referenceTuningMock(importOriginal as never);
});

import { parseCatalogCsv } from "../../src/modules/onboarding/catalog-csv";
import {
  PrismaCatalogRepository,
  toEngineCatalog
} from "../../src/modules/onboarding/catalog.repository";
import { candidates, classify, isGiftable, run } from "../../src/modules/onboarding/engine";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { MANUAL_REFUSALS, swapRewardToItem } from "../../src/modules/onboarding/swap";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * The centre's "Prize (Y/N)" column: once a catalogue carries any answer, only the rows marked Y
 * are looked at for a prize, in every milestone and everywhere else a prize is chosen.
 */
const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const base = catalog as CatalogItem[];

describe("the Prize (Y/N) column in the CSV", () => {
  const read = (csv: string) => parseCatalogCsv(csv);

  it("reads Y and N for each row, whatever the header's hint says", () => {
    const { items, skipped } = read("Nombre;Precio;Prize (Y/N)\nFacial;60;Y\nMasaje;45;N");

    expect(skipped).toEqual([]);
    expect(items.map((i) => i.prize)).toEqual([true, false]);
  });

  it("also takes the Spanish header and Sí/No", () => {
    const { items } = read("Nombre;Precio;Premio (S/N)\nFacial;60;Sí\nMasaje;45;no");

    expect(items.map((i) => i.prize)).toEqual([true, false]);
  });

  it("takes a blank answer as N, and says how many", () => {
    const { items, notes } = read("Nombre;Precio;Prize\nFacial;60;Y\nMasaje;45;");

    expect(items.map((i) => i.prize)).toEqual([true, false]);
    expect(notes.join(" ")).toContain("1 filas tenían la columna de premio vacía");
  });

  it("skips a row whose answer is neither, and reports its line", () => {
    const { items, skipped } = read("Nombre;Precio;Prize (Y/N)\nFacial;60;Y\nMasaje;45;quizás");

    expect(items).toHaveLength(1);
    expect(skipped).toEqual([expect.objectContaining({ line: 3 })]);
  });

  it("warns when no row is a Y, since no prize can then be made", () => {
    const { notes } = read("Nombre;Precio;Prize (Y/N)\nFacial;60;N");

    expect(notes.join(" ")).toContain("Ninguna fila está marcada con Y");
  });

  it("leaves the answer unset when the file has no such column", () => {
    const { items, notes } = read("Nombre;Precio\nFacial;60");

    expect(items[0]).not.toHaveProperty("prize");
    expect(notes).toEqual([]);
  });

  it("finds the column wherever it sits, next to the product and category ones", () => {
    const { items } = read("Prize (Y/N);Nombre;Precio;Producto\nY;Crema;30;sí\nN;Facial;60;no");

    expect(items).toEqual([
      expect.objectContaining({ name: "Crema", isProduct: true, prize: true }),
      expect.objectContaining({ name: "Facial", prize: false })
    ]);
  });
});

describe("storing the answer", () => {
  it("hands the engine true or false, and nothing at all when the centre never answered", () => {
    const row = (prizeEligible: boolean | null) =>
      ({
        externalId: "a",
        name: "A",
        priceCents: 1000,
        isProduct: false,
        categoryId: null,
        costPctOverride: null,
        estimated: false,
        prizeEligible
      }) as never;

    const [yes, no, never] = toEngineCatalog([row(true), row(false), row(null)]);

    expect(yes.prize).toBe(true);
    expect(no.prize).toBe(false);
    expect(never).not.toHaveProperty("prize");
  });

  const fakePrisma = () => {
    const upsert = vi.fn(async () => ({}));
    const tx = { catalogItem: { deleteMany: vi.fn(async () => ({})), upsert } };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      catalogItem: { findMany: vi.fn(async () => []) }
    } as unknown as PrismaClient;

    return { prisma, upsert };
  };

  it("writes the answer when given, and leaves a stored one alone when the editor sends none", async () => {
    const { prisma, upsert } = fakePrisma();

    await new PrismaCatalogRepository(prisma).replaceForClinic("c1", [
      { externalId: "a", name: "A", priceEuro: 10, prize: true },
      { externalId: "b", name: "B", priceEuro: 10 }
    ]);

    const [withAnswer, without] = upsert.mock.calls.map(
      (call) => call as unknown as [{ update: object; create: { prizeEligible: unknown } }]
    );

    expect(withAnswer[0].update).toMatchObject({ prizeEligible: true });
    // An editor that does not know the column must not wipe it on every save.
    expect(without[0].update).not.toHaveProperty("prizeEligible");
    expect(without[0].create.prizeEligible).toBeNull();
  });
});

describe("the engine looks only at rows marked Y", () => {
  /** The first few catalogue rows that could be a prize on their own, marked Y. */
  const withAnswers = (yes: Set<string>): CatalogItem[] =>
    base.map((row) => ({ ...row, prize: yes.has(row.id) }));

  const allowed = () => {
    const ids = candidates(classify(base), ANSWERS).map((c) => c.id);

    // Every other candidate, so the filter has something left to choose from.
    return new Set(ids.filter((_, index) => index % 2 === 0));
  };

  const idsOf = (program: Program): string[] => [
    ...program.chosen.flatMap((c) => c.o.items.map((i) => i.id)),
    ...program.chosen.flatMap((c) => c.alts.flatMap((a) => a.items.map((i) => i.id))),
    ...program.rec.o.items.map((i) => i.id),
    ...Object.values(program.gifts).flatMap((g) => g.birthday?.items.map((i) => i.id) ?? []),
    ...program.perks.pool.map((c) => c.id)
  ];

  it("offers as candidates only the rows marked Y", () => {
    const yes = allowed();
    const offered = candidates(classify(withAnswers(yes)), ANSWERS).map((c) => c.id);

    expect(offered.length).toBeGreaterThan(0);
    expect(new Set(offered)).toEqual(yes);
  });

  it("builds every prize of the programme from those rows alone", () => {
    const yes = allowed();
    const program = run(withAnswers(yes), ANSWERS);

    if (isEngineError(program)) throw new Error(program.error);

    const used = idsOf(program);

    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((id) => !yes.has(id))).toEqual([]);
  });

  it("changes nothing for a catalogue with no answers at all", () => {
    const plain = run(base, ANSWERS);
    const none = run(
      base.map((row) => ({ ...row })),
      ANSWERS
    );

    if (isEngineError(plain) || isEngineError(none)) throw new Error("engine failed");

    expect(idsOf(none)).toEqual(idsOf(plain));
    expect(classify(base).some((row) => row.prizeOff)).toBe(false);
  });

  it("refuses with a clear message when nothing is marked Y", () => {
    const result = run(withAnswers(new Set()), ANSWERS);

    expect(isEngineError(result)).toBe(true);
  });

  it("keeps a diagnosis out of the free-diagnosis perk unless it is marked Y", () => {
    const dias = classify(base).filter((row) => row.cat === "DIA" && !row.review);

    // A catalogue that marks every row Y except the diagnoses.
    const program = run(
      base.map((row) => ({ ...row, prize: !dias.some((d) => d.id === row.id) })),
      ANSWERS
    );

    if (isEngineError(program)) throw new Error(program.error);

    expect(program.perks.dias).toEqual([]);
    expect(program.perks.kinds).not.toContain("diag");
  });

  it("refuses a hand pick of a row not marked Y, in the admin's swap too", () => {
    const yes = allowed();
    const items = withAnswers(yes);
    const program = run(items, ANSWERS);

    if (isEngineError(program)) throw new Error(program.error);

    const off = classify(items).find((row) => row.prizeOff && row.price > 0 && row.cat !== "MED");

    expect(off).toBeDefined();
    expect(isGiftable(off!)).toBe(false);

    const swapped = swapRewardToItem(program, ANSWERS, program.chosen[0].m.n, off!.id);

    expect(swapped).toEqual({ ok: false, reason: MANUAL_REFUSALS.prize });
  });
});
