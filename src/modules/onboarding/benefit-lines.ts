import { P, TIERS, TIER_BENEFITS } from "./engine.config";
import type { BenefitOverride, Program, TierCode } from "./engine.types";
import { itemsTitle } from "./reward-title";

/**
 * The benefit lines of a tier, and the display-only overrides a centre may put on them.
 *
 * The engine generates most of a tier's lines from its rules (multiplier, discount, birthday gift,
 * events, tests and a few fixed sentences). A centre may reword or hide any of them, exactly like
 * the lines it added itself, but ONLY the sentence changes: the multiplier, the discount and the
 * gift keep running as generated. An override is therefore stored apart from the programme's real
 * fields, by a STABLE key derived from what the line is — never from its position or its words, or
 * rewording a sentence in the engine would orphan every override saved against it.
 *
 * Pure.
 */

/** A generated line before any override: its stable key and the words the engine gives it. */
export interface GeneratedLine {
  key: string;
  text: string;
}

/**
 * One line of a tier as the admin screen lists it, hidden ones included so it can show and
 * restore them. `text` is what a client reads (the override, when there is one); `original` is
 * what the engine or the centre wrote.
 */
export interface PresentedBenefitLine {
  key: string;
  text: string;
  original: string;
  kind: "generated" | "custom";
  edited: boolean;
  hidden: boolean;
}

const pct = (share: number): string => `${Math.round(share * 100)}%`;

/** The key of a line the centre added, by its position in its own list. */
export const customKey = (index: number): string => `custom:${index}`;

/** What the engine generates for a tier, in the order a client would care about it. */
export const generatedLines = (key: TierCode, program: Program): GeneratedLine[] => {
  const b = TIER_BENEFITS[key];
  const out: GeneratedLine[] = [];

  if (b.mult > 1) {
    out.push({
      key: "mult",
      text: `Cada euro suma ×${String(b.mult).replace(".", ",")} de progreso`
    });
  }

  if (b.discount > 0) {
    out.push({
      key: "discount",
      text: `Descuento del ${pct(b.discount)} en cosmética, hasta ${P.discountMaxProducts} productos al año`
    });
  }

  const gift = program.gifts[key]?.birthday;

  if (gift) out.push({ key: "birthday", text: `Regalo de cumpleaños: ${itemsTitle(gift.items)}` });

  if (b.events > 0) {
    out.push({
      key: "events",
      text: b.events === 1 ? "Un evento exclusivo al año" : `${b.events} eventos exclusivos al año`
    });
  }

  if (b.tests) out.push({ key: "tests", text: "Prueba de nuevos tratamientos y aparatología" });

  out.push(...b.extra);

  return out;
};

/** Every line of a tier, generated then added, with the centre's overrides applied. */
export const benefitLinesFor = (key: TierCode, program: Program): PresentedBenefitLine[] => {
  const overrides = program.benefitOverrides?.[key] ?? {};

  const generated = generatedLines(key, program).map((line): PresentedBenefitLine => {
    const override = overrides[line.key];
    const edited = override?.text !== undefined && override.text !== line.text;

    return {
      key: line.key,
      text: edited ? (override?.text as string) : line.text,
      original: line.text,
      kind: "generated",
      edited,
      hidden: override?.hidden === true
    };
  });

  const custom = (program.customBenefits?.[key] ?? []).map((text, index): PresentedBenefitLine => ({
    key: customKey(index),
    text,
    original: text,
    kind: "custom",
    edited: false,
    hidden: false
  }));

  return [...generated, ...custom];
};

/** The refusal for any change that would leave a tier with nothing to show. */
export const NO_VISIBLE_LINE = "Cada nivel debe mostrar al menos un beneficio.";

/** How many lines of the tier a client would read, generated and added ones together. */
export const visibleLineCount = (key: TierCode, program: Program): number =>
  benefitLinesFor(key, program).filter((l) => !l.hidden).length;

/** What a client reads: the visible lines' words, in order. */
export const visibleBenefits = (lines: PresentedBenefitLine[]): string[] =>
  lines.filter((l) => !l.hidden).map((l) => l.text);

/**
 * One change to one line. Each entry REPLACES that line's override as a whole: `text` null or
 * absent clears the edit, `hidden` null, false or absent shows the line, and an entry with
 * neither clears the override altogether.
 */
export interface BenefitOverrideEntry {
  key: string;
  text?: string | null;
  hidden?: boolean | null;
}

export type BenefitOverridesResult = { ok: true; program: Program } | { ok: false; reason: string };

const fail = (reason: string): BenefitOverridesResult => ({ ok: false, reason });

/**
 * Applies a batch of overrides to one tier of a draft's programme. All or nothing: it returns a
 * new programme, or the first refusal and no programme at all, so a request with one bad key
 * stores none of its edits. A key is valid only if the tier actually has that generated line in
 * this programme (Bronce has no multiplier, a tier without a gift has no birthday line).
 */
export const applyBenefitOverrides = (
  program: Program,
  tier: TierCode,
  entries: BenefitOverrideEntry[]
): BenefitOverridesResult => {
  if (!TIERS.includes(tier)) return fail("Ese nivel no existe.");

  const lines = new Map(generatedLines(tier, program).map((line) => [line.key, line]));
  const seen = new Set<string>();
  // Overrides saved against a line this programme no longer generates could never be cleared
  // (an entry for an unknown key is refused), so they are dropped whenever the tier is changed.
  const next: Record<string, BenefitOverride> = Object.fromEntries(
    Object.entries(program.benefitOverrides?.[tier] ?? {}).filter(([key]) => lines.has(key))
  );

  for (const entry of entries) {
    if (entry.key.startsWith("custom:")) {
      return fail(
        "Ese beneficio lo añadiste tú: para cambiarlo o quitarlo edita la lista de beneficios del nivel."
      );
    }

    const line = lines.get(entry.key);

    if (!line) return fail("Ese beneficio no existe en este nivel.");

    if (seen.has(entry.key)) return fail("No repitas el mismo beneficio en una misma petición.");

    seen.add(entry.key);

    const override: BenefitOverride = {};

    // A text equal to the generated one is no edit: storing it would pin the line against a
    // later improvement of the engine's wording for nothing.
    if (entry.text != null && entry.text !== line.text) override.text = entry.text;
    if (entry.hidden === true) override.hidden = true;

    if (Object.keys(override).length === 0) delete next[entry.key];
    else next[entry.key] = override;
  }

  const overrides = { ...(program.benefitOverrides ?? {}) };

  if (Object.keys(next).length === 0) delete overrides[tier];
  else overrides[tier] = next;

  const result: Program = { ...program };

  if (Object.keys(overrides).length === 0) delete result.benefitOverrides;
  else result.benefitOverrides = overrides;

  // A tier with no visible line makes the wallets disagree (Apple falls back to the template's
  // hand-typed text, Google shows nothing), so it is never stored. A request that leaves the
  // tier no better off than it was is judged the same: only showing a line again gets through.
  if (visibleLineCount(tier, result) === 0) return fail(NO_VISIBLE_LINE);

  return { ok: true, program: result };
};
