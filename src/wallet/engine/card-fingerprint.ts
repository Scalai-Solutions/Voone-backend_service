import type { LoyaltyCard } from "./loyalty-card";

/**
 * A string that is equal for two cards exactly when they say the same thing.
 *
 * Keys are sorted at every depth, so two assemblies of an unchanged member compare equal
 * however their object literals happened to be ordered, and a field that is `undefined`
 * is dropped, as it would be on the wire. Deliberately not a hash: nothing here is stored
 * or sent anywhere, it is only compared in memory, and a collision-free string needs no
 * argument that a digest does.
 */
export const cardFingerprint = (card: LoyaltyCard): string =>
  JSON.stringify(card, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          )
        )
      : value
  );
