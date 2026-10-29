import { formatMadridDayMonth } from "./card-message";
import type { LoyaltyCard } from "./loyalty-card";
import { MONTHS_ES_REWARDS } from "./rewards-text";

/**
 * The words about a pending x2, shared by both wallets so the Apple back field and the Google text
 * module can never say different things.
 *
 * The date is the stored expiry in Europe/Madrid, never "now", so rebuilding an unchanged card
 * gives byte-identical text and does not notify again. Same "sept" style as the rewards line.
 */
export const BOOST_FIRST_VISIT_TEXT = "Tu primera visita suma el doble de puntos.";

const NEXT_VISIT_TEXT = "Tu próxima visita suma el doble de puntos.";

/** Undefined for a card with no `boost`: nothing to say. */
export const boostText = (card: Pick<LoyaltyCard, "boost">): string | undefined => {
  const { boost } = card;

  if (!boost) return undefined;

  if (boost.kind === "referral") return BOOST_FIRST_VISIT_TEXT;

  return boost.until
    ? `${NEXT_VISIT_TEXT} Válido hasta el ${formatMadridDayMonth(new Date(boost.until), MONTHS_ES_REWARDS)}.`
    : NEXT_VISIT_TEXT;
};
