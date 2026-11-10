import { formatMadridDayMonth } from "./card-message";
import type { LoyaltyCard } from "./loyalty-card";
import { MONTHS_ES_REWARDS } from "./rewards-text";

/** How many movements the card lists: enough to read at a glance, short enough for one back field. */
export const CARD_HISTORY_MAX = 10;

type Entry = NonNullable<LoyaltyCard["history"]>[number];

/**
 * The words for each kind of movement. Fixed, never the ledger's own `reason`: for a manual
 * adjustment that is a staff note, and for a visit it can be a treatment name, which the ledger
 * deliberately does not treat as card content.
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
        `${formatMadridDayMonth(new Date(entry.at), MONTHS_ES_REWARDS)} · ${LABELS[entry.kind]} · ${signed(entry.points)} puntos`
    )
    .join("\n");
};
