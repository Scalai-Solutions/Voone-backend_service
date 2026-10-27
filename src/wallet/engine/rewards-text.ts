import { formatMadridDayMonth } from "./card-message";
import type { LoyaltyCard } from "./loyalty-card";

/**
 * The words about a member's redeemable rewards, shared by both wallets so the Apple back field and
 * the Google text module can never say different things.
 *
 * Plain text, one reward per line. Dates are the stored expiry in Europe/Madrid, never "now", so
 * rebuilding an unchanged card gives byte-identical text and does not notify again.
 */

/** Lines listed before the rest are counted: a back field is read, not scrolled for ever. */
export const REWARD_LINES_SHOWN = 8;

export const REDEEM_INSTRUCTION = "Preséntalas en el centro para canjearlas.";

const NONE_YET = "Aún no tienes recompensas disponibles.";

// "sept", the way the clinic writes it for a reward deadline. The clinic-message date keeps "sep"
// (its text is compared byte for byte against what phones already hold), so this list is the
// rewards line's own.
const MONTHS_ES_REWARDS = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sept",
  "oct",
  "nov",
  "dic"
] as const;

export const availableRewardCount = (card: Pick<LoyaltyCard, "rewards">): number =>
  card.rewards?.available.length ?? 0;

/** Undefined for a card with no `rewards` (a clinic with no programme): nothing to say. */
export const availableRewardsText = (
  card: Pick<LoyaltyCard, "rewards" | "reward">
): string | undefined => {
  if (!card.rewards) return undefined;

  const { available } = card.rewards;

  if (available.length === 0) {
    const next = card.reward?.description.trim().replace(/\.+$/, "");

    return [next ? `${NONE_YET} ${next}.` : NONE_YET, REDEEM_INSTRUCTION].join("\n");
  }

  const lines = available
    .slice(0, REWARD_LINES_SHOWN)
    .map(
      (reward) =>
        `🎁 ${reward.title} · hasta ${formatMadridDayMonth(new Date(reward.expiresAt), MONTHS_ES_REWARDS)}`
    );

  if (available.length > REWARD_LINES_SHOWN) {
    lines.push(`… y ${available.length - REWARD_LINES_SHOWN} más`);
  }

  return [...lines, REDEEM_INSTRUCTION].join("\n");
};
