import { describe, expect, it } from "vitest";

import { parseCatalogCsv } from "../../src/modules/onboarding/catalog-csv";

/**
 * The CSV import, against the cases a real spreadsheet export produces.
 *
 * The guide's contract is short — two columns, `;` or tab, bad rows skipped and reported —
 * but a Spanish centre's export exercises every awkward corner of it: decimal commas,
 * thousands dots, a euro sign, a price band, Windows line endings, a byte-order mark. Each is
 * here because a naive parser gets it wrong silently, which for a price is the worst way.
 */
const prices = (csv: string) => parseCatalogCsv(csv).items.map((i) => i.priceEuro);

describe("parseCatalogCsv separators", () => {
  it("reads semicolons", () => {
    expect(parseCatalogCsv("Facial;60\nMasaje;45").items).toHaveLength(2);
  });

  it("reads tabs, as pasted from a spreadsheet", () => {
    expect(parseCatalogCsv("Facial\t60\nMasaje\t45").items).toHaveLength(2);
  });

  it("does NOT split on commas, because the comma is the decimal mark", () => {
    // Splitting on it would read "60,50" as a price of 60 and a stray cell of 50.
    const { items, skipped } = parseCatalogCsv("Facial;60,50");

    expect(items).toHaveLength(1);
    expect(items[0].priceEuro).toBe(60.5);
    expect(skipped).toEqual([]);
  });

  it("copes with Windows line endings and a byte-order mark", () => {
    const { items, skipped } = parseCatalogCsv("\uFEFFNombre;Precio\r\nFacial;60\r\nMasaje;45\r\n");

    expect(items.map((i) => i.name)).toEqual(["Facial", "Masaje"]);
    // The assertion that matters: with the BOM left glued to "Nombre" the header is no longer
    // recognised and gets reported as a bad row, which the names alone would not reveal.
    expect(skipped).toEqual([]);
  });

  it("ignores blank lines", () => {
    expect(parseCatalogCsv("Facial;60\n\n  \nMasaje;45\n").items).toHaveLength(2);
  });

  it("strips quotes around a cell", () => {
    expect(parseCatalogCsv('"Facial; detox";60').items[0].name).toBe("Facial; detox");
  });
});

describe("parseCatalogCsv prices", () => {
  it("reads Spanish formats", () => {
    expect(prices("a;60\nb;60,5\nc;60.5\nd;1.250\ne;1.234,50\nf;60 €\ng;60€\nh;60 euros")).toEqual([
      60, 60.5, 60.5, 1250, 1234.5, 60, 60, 60
    ]);
  });

  it("takes the midpoint of a price band and says so", () => {
    const { items, notes } = parseCatalogCsv("Botox;410-450€");

    expect(items[0].priceEuro).toBe(430);
    expect(notes[0]).toContain("punto medio");
    expect(notes[0]).toContain("Botox");
  });

  it("reads a band written with an en dash or the word 'a'", () => {
    expect(prices("a;100–120\nb;100 a 120")).toEqual([110, 110]);
  });

  it("accepts a price of zero, which is never a reward but is a valid row", () => {
    expect(prices("Consulta;0")).toEqual([0]);
  });

  it("rejects a price that is not a number, and says which line", () => {
    const { items, skipped } = parseCatalogCsv("Facial;60\nMasaje;gratis\nPeeling;40");

    expect(items.map((i) => i.name)).toEqual(["Facial", "Peeling"]);
    expect(skipped).toEqual([
      { line: 2, reason: "El precio no es un número.", raw: "Masaje;gratis" }
    ]);
  });

  it("rejects a negative price and an inverted band", () => {
    expect(parseCatalogCsv("a;-5\nb;120-100").skipped).toHaveLength(2);
  });
});

describe("parseCatalogCsv rows that fail", () => {
  it("skips them and keeps going, reporting each", () => {
    // One typo must cost one row, not the whole import.
    const { items, skipped } = parseCatalogCsv("Facial;60\nsolo una columna\n;45\nMasaje;45");

    expect(items.map((i) => i.name)).toEqual(["Facial", "Masaje"]);
    expect(skipped.map((s) => s.line)).toEqual([2, 3]);
    expect(skipped[0].reason).toContain("columnas");
    expect(skipped[1].reason).toContain("nombre");
  });

  it("skips a name over the limit", () => {
    expect(parseCatalogCsv(`${"x".repeat(121)};10`).skipped[0].reason).toContain("120");
  });

  it("returns nothing, and complains of nothing, for an empty file", () => {
    expect(parseCatalogCsv("")).toEqual({ items: [], skipped: [], notes: [] });
  });
});

describe("parseCatalogCsv header", () => {
  it("skips a header recognised by its words", () => {
    expect(parseCatalogCsv("Nombre;Precio\nFacial;60").items).toHaveLength(1);
    expect(parseCatalogCsv("Tratamiento;Importe\nFacial;60").items).toHaveLength(1);
    expect(parseCatalogCsv("name;price\nFacial;60").items).toHaveLength(1);
  });

  it("does NOT swallow a first data row that merely has a typo", () => {
    // The trap in the easy rule. If "first row, price not a number" meant header, a centre
    // whose very first treatment was mistyped would lose it without a word.
    const { items, skipped } = parseCatalogCsv("Facial;sesenta\nMasaje;45");

    expect(items.map((i) => i.name)).toEqual(["Masaje"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].line).toBe(1);
  });

  it("works with no header at all", () => {
    expect(parseCatalogCsv("Facial;60").items).toHaveLength(1);
  });
});

describe("parseCatalogCsv ids", () => {
  it("derives a stable id from the name", () => {
    expect(parseCatalogCsv("Higiene facial Detox;60").items[0].externalId).toBe(
      "higiene-facial-detox"
    );
  });

  it("strips accents and punctuation", () => {
    expect(parseCatalogCsv("Láser (cuerpo) – zona mini;20").items[0].externalId).toBe(
      "laser-cuerpo-zona-mini"
    );
  });

  it("does not change when rows are reordered or inserted", () => {
    // Why ids come from the name and not the position: the engine breaks every tie on id, so
    // an id that shifted when a row was added above it would change the reward ladder.
    const a = parseCatalogCsv("Facial;60\nMasaje;45").items;
    const b = parseCatalogCsv("Nuevo;10\nMasaje;45\nFacial;60").items;
    const idOf = (items: typeof a, name: string) => items.find((i) => i.name === name)?.externalId;

    expect(idOf(a, "Facial")).toBe(idOf(b, "Facial"));
    expect(idOf(a, "Masaje")).toBe(idOf(b, "Masaje"));
  });

  it("keeps duplicate names apart", () => {
    const ids = parseCatalogCsv("Facial;60\nFacial;70\nFacial;80").items.map((i) => i.externalId);

    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(["facial", "facial-2", "facial-3"]);
  });

  it("falls back to something for a name with no letters", () => {
    expect(parseCatalogCsv("***;10").items[0].externalId).toBe("fila");
  });
});

describe("parseCatalogCsv the optional third column", () => {
  it("marks retail products, which the engine files under cosmetics", () => {
    const [a, b, c] = parseCatalogCsv(
      "Crema;40;producto\nSérum;55;Producto\nGel;20;cosmética"
    ).items;

    expect([a, b, c].every((i) => i.isProduct)).toBe(true);
  });

  it("accepts a category the centre chose", () => {
    expect(parseCatalogCsv("Facial;60;FAC").items[0].categoryId).toBe("FAC");
    expect(parseCatalogCsv("Facial;60;fac").items[0].categoryId).toBe("FAC");
  });

  it("rejects an unknown word there rather than guessing", () => {
    const { items, skipped } = parseCatalogCsv("Facial;60;xyz");

    expect(items).toEqual([]);
    expect(skipped[0].reason).toContain("tercera columna");
  });

  it("is optional", () => {
    expect(parseCatalogCsv("Facial;60").items[0].isProduct).toBeUndefined();
  });
});
