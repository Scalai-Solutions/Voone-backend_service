import { cardFingerprint } from "../../src/wallet/engine/card-fingerprint";
import type { LoyaltyCard } from "../../src/wallet/engine/loyalty-card";

export const fingerprintOf = (card: LoyaltyCard): string => cardFingerprint(card);
