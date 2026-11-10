import type { LoyaltyCard } from "./loyalty-card";

/** The label on both wallets. Short on purpose: it heads a cell on the front of the card. */
export const SAVINGS_LABEL = "Ahorro";

/**
 * The member's total saved as the card prints it, "120 €" or "123,45 €", or undefined while nothing
 * has been saved: the card then shows no savings at all rather than a zero.
 */
export const savingsText = (card: Pick<LoyaltyCard, "savings">): string | undefined => {
  const savings = card.savings;

  if (!savings || savings.cents <= 0) return undefined;

  const whole = savings.cents % 100 === 0;

  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: savings.currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2
  })
    .format(savings.cents / 100)
    .split(String.fromCharCode(0xa0))
    .join(" ");
};
