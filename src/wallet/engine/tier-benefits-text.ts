import type { LoyaltyCard } from "./loyalty-card";
import { clipText } from "./rewards-text";

/**
 * The words about the benefits of a member's CURRENT tier, shared by both wallets so the Apple back
 * field and the Google text module can never say different things.
 *
 * Plain text: the tier name first, then one bullet per benefit. The lines come from the clinic's
 * onboarding programme (the single source of truth), already fitted by `fitTierBenefits`, so
 * rebuilding an unchanged card gives byte-identical text and does not notify again.
 */

/** The most the rendered text may hold: the card's own cap on a free-text field. */
export const TIER_BENEFITS_TEXT_MAX = 500;
/** The most lines a card carries, the overflow line included. */
export const TIER_BENEFITS_LINES_MAX = 12;
/** The longest single line, in the card schema's own unit (UTF-16 units, never half an emoji). */
export const TIER_BENEFIT_LINE_MAX = 120;

const MORE_PREFIX = "… y ";

const moreLine = (left: number): string => `${MORE_PREFIX}${left} más`;

const render = (tier: string, lines: string[]): string =>
  [tier, ...lines.map((line) => (line.startsWith(MORE_PREFIX) ? line : `• ${line}`))].join("\n");

/**
 * The benefit lines a card can carry: trimmed, blanks dropped, each cut to 120, and as many as fit
 * the rendered text (tier name and bullets included) in 500 characters and 12 lines. When some are
 * left out the last line says how many ("… y 3 más"), as the rewards text does.
 */
export const fitTierBenefits = (tier: string, benefits: string[]): string[] => {
  const lines = benefits
    .map((line) => clipText(line.trim(), TIER_BENEFIT_LINE_MAX, true))
    .filter((line) => line.length > 0);

  if (
    lines.length <= TIER_BENEFITS_LINES_MAX &&
    render(tier, lines).length <= TIER_BENEFITS_TEXT_MAX
  ) {
    return lines;
  }

  for (
    let shown = Math.min(lines.length - 1, TIER_BENEFITS_LINES_MAX - 1);
    shown >= 0;
    shown -= 1
  ) {
    const fitted = [...lines.slice(0, shown), moreLine(lines.length - shown)];

    if (render(tier, fitted).length <= TIER_BENEFITS_TEXT_MAX) return fitted;
  }

  return [moreLine(lines.length)];
};

/** Undefined for a card with no `tierBenefits` (no live programme, or a tier with none): nothing to say. */
export const tierBenefitsText = (card: Pick<LoyaltyCard, "tierBenefits">): string | undefined =>
  card.tierBenefits ? render(card.tierBenefits.tier, card.tierBenefits.lines) : undefined;
