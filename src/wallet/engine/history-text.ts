import { formatMadridDayMonth } from "./card-message";
import type { LoyaltyCard } from "./loyalty-card";
import { clipText, MONTHS_ES_REWARDS } from "./rewards-text";

export { CARD_HISTORY_MAX } from "./loyalty-card";

type Entry = NonNullable<LoyaltyCard["history"]>[number];

/** The longest treatment name a line carries; a longer one is cut with an ellipsis. */
const NAME_MAX = 40;

/**
 * The words for each kind of movement when there is no name to give. Fixed, never the ledger's own
 * `reason`: for a manual adjustment that is a staff note, which must not reach a client's phone.
 */
const LABELS: Record<Entry["kind"], string> = {
  visit: "Visita",
  referral: "Recomendación",
  gift: "Puntos de regalo",
  adjustment: "Ajuste",
  redeem: "Canje",
  expiry: "Caducidad"
};

const signed = (points: number): string =>
  `${points > 0 ? "+" : "−"}${Math.abs(points).toLocaleString("es-ES")}`;

/**
 * The member's latest movements, newest first, one line each: `12 nov · Visita · +450 puntos`.
 * Undefined for a card with no history: nothing to say.
 *
 * Dates are the stored instant in Europe/Madrid, never "hace 2 días": a relative date would
 * change every day for an unchanged member and push the pass for nothing.
 */
export const historyText = (card: Pick<LoyaltyCard, "history">): string | undefined => {
  const entries = card.history ?? [];

  if (entries.length === 0) return undefined;

  return entries
    .map(
      (entry) =>
        `${formatMadridDayMonth(new Date(entry.at), MONTHS_ES_REWARDS)} · ${entry.name ? clipText(entry.name, NAME_MAX, true) : LABELS[entry.kind]} · ${signed(entry.points)} puntos`
    )
    .join("\n");
};
