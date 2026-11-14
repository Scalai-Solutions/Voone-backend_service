import { NO_VISIBLE_LINE, generatedLines, visibleLineCount } from "./benefit-lines";
import { realThresholds } from "./engine";
import { TIERS, TIER_BENEFITS } from "./engine.config";
import type { Program, RewardOption, TierCode, TierGift } from "./engine.types";
import { retotal, type SwapResult } from "./swap";

/**
 * The REAL rules of a tier a centre may set: its progress multiplier, its cosmetics discount and its
 * birthday gift. Unlike a benefit override (benefit-lines.ts), which only rewords a sentence, these
 * change what visits apply, what the pass says and what the birthday message names.
 *
 * Pure.
 */

/** The same limits the route validates; repeated here so the rule holds for any caller. */
export const TIER_RULE_LIMITS = {
  mult: { min: 1, max: 3 },
  discount: { min: 0, max: 0.5 }
} as const;

/**
 * One change to a tier. An absent field is left as it is; `birthday: null` removes the gift.
 * `discount` is a fraction (0.05 is 5%). `birthday.name` is set only for a gift the centre typed.
 */
export interface TierRulesChange {
  mult?: number;
  discount?: number;
  birthday?: { o: RewardOption; name?: string } | null;
  /**
   * The tier's whole free-text list, as the edit dialog saves it. When present it REPLACES every
   * line that is text only: the centre's own lines become this list, and the engine's fixed
   * sentences (events, tests, extras) are hidden, since the dialog offered them as part of it.
   */
  freeText?: string[];
}

/** The generated lines a real value drives. Every other generated line is text only. */
const RULE_LINE_KEYS = new Set(["mult", "discount", "birthday"]);

const fail = (reason: string): SwapResult => ({ ok: false, reason });

const inRange = (value: number, range: { min: number; max: number }): boolean =>
  Number.isFinite(value) && value >= range.min && value <= range.max;

export const applyTierRules = (
  program: Program,
  tier: TierCode,
  change: TierRulesChange
): SwapResult => {
  if (!TIERS.includes(tier)) return fail("Ese nivel no existe.");

  if (change.mult !== undefined && !inRange(change.mult, TIER_RULE_LIMITS.mult)) {
    return fail("El multiplicador tiene que estar entre ×1 y ×3.");
  }

  if (change.discount !== undefined && !inRange(change.discount, TIER_RULE_LIMITS.discount)) {
    return fail("El descuento tiene que estar entre el 0% y el 50%.");
  }

  const next = structuredClone(program);
  const rule = { ...next.tierRules?.[tier] };
  // The keys of the generated lines these fields drive (see `generatedLines`).
  const changed: string[] = [];

  for (const field of ["mult", "discount"] as const) {
    const value = change[field];

    if (value === undefined) continue;

    // The config's own value is not stored, so a tier put back keeps following the config.
    if (value === TIER_BENEFITS[tier][field]) delete rule[field];
    else rule[field] = value;

    changed.push(field);
  }

  const rules = { ...next.tierRules };

  if (Object.keys(rule).length > 0) rules[tier] = rule;
  else delete rules[tier];

  if (Object.keys(rules).length > 0) next.tierRules = rules;
  else delete next.tierRules;

  if (change.birthday !== undefined) {
    const gift: TierGift = change.birthday
      ? {
          birthday: change.birthday.o,
          ...(change.birthday.name ? { birthdayName: change.birthday.name } : {})
        }
      : {};

    next.gifts = { ...next.gifts, [tier]: gift };
    changed.push("birthday");
  }

  // A sentence reworded or hidden for the old value would now contradict the real one.
  const overrides = next.benefitOverrides?.[tier];

  if (overrides && next.benefitOverrides) {
    for (const key of changed) delete overrides[key];

    if (Object.keys(overrides).length === 0) delete next.benefitOverrides[tier];
    if (Object.keys(next.benefitOverrides).length === 0) delete next.benefitOverrides;
  }

  if (change.freeText !== undefined) {
    // The list the dialog showed IS the tier now: its real lines read their value (a line hidden
    // before is shown again) and the text lies only in `customBenefits`.
    // shortcut: a fixed sentence added to TIER_BENEFITS.extra later shows on tiers saved this way, as
    // its key is not hidden yet; hide new keys on the next dialog save if that ever matters.
    const textOnly = generatedLines(tier, next)
      .map((line) => line.key)
      .filter((key) => !RULE_LINE_KEYS.has(key));

    next.customBenefits = { ...next.customBenefits, [tier]: change.freeText };
    next.benefitOverrides = { ...next.benefitOverrides };

    if (textOnly.length > 0) {
      next.benefitOverrides[tier] = Object.fromEntries(
        textOnly.map((key) => [key, { hidden: true }])
      );
    } else {
      delete next.benefitOverrides[tier];
    }

    if (Object.keys(next.benefitOverrides).length === 0) delete next.benefitOverrides;
  }

  // Spend is progress divided by the multiplier, so every "Desde X € gastados" moves with it.
  if (change.mult !== undefined) {
    next.realTh = realThresholds(next.lad.ms, next.tierRules);
    next.diamondReal = next.realTh[next.lad.last.n];
  }

  if (visibleLineCount(tier, next) === 0) return fail(NO_VISIBLE_LINE);

  return { ok: true, program: retotal(next) };
};
