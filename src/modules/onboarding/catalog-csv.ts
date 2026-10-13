import type { CatalogInput } from "./catalog.repository";
import { CATEGORIES } from "./engine.config";
import type { CategoryCode } from "./engine.types";

/**
 * Reading a centre's price list from a spreadsheet export.
 *
 * The guide asks for exactly this: "two columns minimum (name, price), separator ; or tab.
 * Rows that fail to parse are skipped and reported." So a bad row never aborts the import —
 * a centre with 80 treatments and one typo should lose one row, not start again — and every
 * skipped row comes back with the line it was on and the reason, so the centre can fix it.
 *
 * Comma is deliberately NOT a separator. In Spain the comma is the decimal mark, so
 * "Facial;60,50" is a price of sixty euros fifty and splitting on commas would cut it in half.
 *
 * Pure: text in, rows and complaints out. Nothing here touches the database.
 */

export interface SkippedRow {
  /** 1-based line number in the file, counting the header. */
  line: number;
  reason: string;
  raw: string;
}

export interface CsvImport {
  items: CatalogInput[];
  skipped: SkippedRow[];
  /** Things that were accepted but the centre should know about. */
  notes: string[];
}

const MAX_NAME = 120;

/** Lower-cased and stripped of accents, for comparing what a centre typed to what we expect. */
const plain = (value: string): string =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** A stable identifier from a name, so re-importing a list does not renumber its rows. */
const slugOf = (name: string): string => {
  const slug = plain(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

  return slug || "fila";
};

/**
 * Splits one row on a separator, but not inside double quotes.
 *
 * A quoted cell is how a spreadsheet exports a name that contains the separator — "Facial;
 * detox" — and splitting first then unquoting would cut it in half and misread the price. A
 * doubled quote inside a quoted cell is a literal quote, as in any CSV.
 */
const splitRow = (row: string, separator: string): string[] => {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];

    if (ch === '"') {
      if (quoted && row[i + 1] === '"') {
        current += '""';
        i += 1;
      } else {
        quoted = !quoted;
        current += ch;
      }
    } else if (ch === separator && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  cells.push(current);

  return cells;
};

const unquote = (cell: string): string => {
  const trimmed = cell.trim();

  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replace(/""/g, '"').trim()
    : trimmed;
};

/** One number from a Spanish-formatted amount: "60", "60,5", "1.234,50", "60 €". */
const parseAmount = (text: string): number | null => {
  const cleaned = text.replace(/€|eur(os)?/gi, "").replace(/\s+/g, "");

  if (!/^\d[\d.,]*$/.test(cleaned)) return null;

  let normal = cleaned;

  if (cleaned.includes(",")) {
    // A comma is the decimal mark, which makes any dot a thousands separator.
    normal = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    // "1.250" with no comma reads as one thousand two hundred fifty in Spain.
    normal = cleaned.replace(/\./g, "");
  }

  const value = Number(normal);

  return Number.isFinite(value) ? value : null;
};

/** "410-450 €" as the midpoint, with the fact that it was a range. */
const parsePrice = (text: string): { value: number; range: boolean } | null => {
  const range = text.match(/^(.+?)\s*(?:-|–|—|\ba\b)\s*(.+)$/i);

  if (range) {
    const low = parseAmount(range[1]);
    const high = parseAmount(range[2]);

    if (low !== null && high !== null && high >= low) {
      return { value: Math.round(((low + high) / 2) * 100) / 100, range: true };
    }
  }

  const single = parseAmount(text);

  return single === null ? null : { value: single, range: false };
};

/** Words a spreadsheet's first row uses for its columns, in Spanish and English. */
const HEADER_NAMES = new Set(["nombre", "name", "tratamiento", "servicio", "concepto", "articulo"]);
const HEADER_PRICES = new Set(["precio", "price", "importe", "tarifa", "pvp"]);

/**
 * Whether a first row is a header.
 *
 * Decided by what the cells SAY, not by the price failing to parse. The easy rule — "a first
 * row with no number in the price column is a header" — silently swallows a real data row that
 * has a typo, so a centre whose very first treatment is mistyped would lose it without a word.
 */
const looksLikeHeader = (name: string, price: string): boolean =>
  HEADER_NAMES.has(plain(name)) || HEADER_PRICES.has(plain(price));

const RETAIL_WORDS = new Set(["producto", "productos", "retail", "cosmetica", "venta"]);

/** The optional third column: a retail marker, or a category the centre chose. */
const readKind = (cell: string): { isProduct?: boolean; categoryId?: CategoryCode } | "unknown" => {
  const value = plain(cell);

  if (!value) return {};
  if (RETAIL_WORDS.has(value)) return { isProduct: true };

  const code = cell.trim().toUpperCase();

  return code in CATEGORIES ? { categoryId: code as CategoryCode } : "unknown";
};

export const parseCatalogCsv = (text: string): CsvImport => {
  const items: CatalogInput[] = [];
  const skipped: SkippedRow[] = [];
  const notes: string[] = [];
  const used = new Map<string, number>();

  // A spreadsheet export often leads with a byte-order mark that would otherwise glue itself
  // to the first column header.
  // Compared by code point rather than written as a literal or an escape in a regex: an
  // invisible byte-order mark in source is exactly the thing a formatter or an editor
  // silently rewrites.
  const BOM = 0xfeff;
  const body = text.charCodeAt(0) === BOM ? text.slice(1) : text;
  const lines = body.split(/\r\n|\r|\n/);

  lines.forEach((raw, index) => {
    const line = index + 1;

    if (!raw.trim()) return;

    // Tab first: it cannot appear inside a Spanish price, whereas a semicolon might in a name.
    const cells = splitRow(raw, raw.includes("\t") ? "\t" : ";").map(unquote);

    if (cells.length < 2) {
      skipped.push({ line, reason: "Faltan columnas: hacen falta al menos nombre y precio.", raw });
      return;
    }

    const [name, priceText, kindText = ""] = cells;
    const price = parsePrice(priceText);

    // A first row whose price column is not a number is a header, not a bad row.
    if (index === 0 && looksLikeHeader(name, priceText)) return;

    if (!name) {
      skipped.push({ line, reason: "Falta el nombre.", raw });
      return;
    }

    if (name.length > MAX_NAME) {
      skipped.push({ line, reason: `El nombre supera los ${MAX_NAME} caracteres.`, raw });
      return;
    }

    if (price === null) {
      skipped.push({ line, reason: "El precio no es un número.", raw });
      return;
    }

    const kind = readKind(kindText);

    if (kind === "unknown") {
      skipped.push({
        line,
        reason: `La tercera columna no es "producto" ni una categoría conocida: ${kindText.trim()}.`,
        raw
      });
      return;
    }

    if (price.range) {
      notes.push(
        `Línea ${line}: "${name}" tenía un precio con rango (${priceText.trim()}); se ha guardado el punto medio, ${price.value} €.`
      );
    }

    const base = slugOf(name);
    const seen = used.get(base) ?? 0;

    used.set(base, seen + 1);

    items.push({
      externalId: seen === 0 ? base : `${base}-${seen + 1}`,
      name,
      priceEuro: price.value,
      ...kind
    });
  });

  return { items, skipped, notes };
};
