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
export const MONTHS_ES_REWARDS = [
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

/**
 * `text` cut to at most `max` UTF-16 units without splitting a surrogate pair, with an ellipsis
 * when something was cut. The card schema counts UTF-16 units, so that is the unit used; a cut
 * never leaves half an emoji.
 */
export const clipText = (text: string, max: number, ellipsis = false): string => {
  if (text.length <= max) return text;

  const room = ellipsis ? max - 1 : max;
  let out = "";

  for (const character of text) {
    if (out.length + character.length > room) break;
    out += character;
  }

  return ellipsis ? `${out.trimEnd()}…` : out;
};

/** The longest reward title printed on a line of the back field or the Google module. */
export const REWARD_LINE_TITLE_MAX = 60;

export const availableRewardCount = (card: Pick<LoyaltyCard, "rewards">): number =>
  card.rewards?.available.length ?? 0;

/**
 * Undefined for a card with no `rewards` (a clinic with no programme): nothing to say.
 *
 * `maxLength` bounds the whole text for a surface with a limit (Google's module): lines are
 * dropped from the end, and counted in "… y N más", until it fits.
 */
export const availableRewardsText = (
  card: Pick<LoyaltyCard, "rewards" | "reward">,
  maxLength?: number
): string | undefined => {
  if (!card.rewards) return undefined;

  const { available } = card.rewards;

  if (available.length === 0) {
    const next = card.reward?.description.trim().replace(/\.+$/, "");

    // Nothing to present yet, so no redemption instruction.
    return next ? `${NONE_YET} ${next}.` : NONE_YET;
  }

  const build = (shown: number): string => {
    const lines = available
      .slice(0, shown)
      .map(
        (reward) =>
          `🎁 ${clipText(reward.title, REWARD_LINE_TITLE_MAX, true)} · hasta ${formatMadridDayMonth(new Date(reward.expiresAt), MONTHS_ES_REWARDS)}`
      );

    if (available.length > shown) lines.push(`… y ${available.length - shown} más`);

    return [...lines, REDEEM_INSTRUCTION].join("\n");
  };

  for (let shown = Math.min(available.length, REWARD_LINES_SHOWN); shown >= 1; shown -= 1) {
    const text = build(shown);

    if (maxLength === undefined || text.length <= maxLength) return text;
  }

  return clipText(build(1), maxLength ?? Number.MAX_SAFE_INTEGER);
};
