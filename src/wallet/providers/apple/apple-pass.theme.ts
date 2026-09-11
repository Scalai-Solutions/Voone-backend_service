import { LoyaltyTier } from "../../engine/wallet-pass.types";

export interface ApplePassTheme {
  backgroundColor: string;
  foregroundColor: string;
  labelColor: string;
}

/**
 * A storeCard supports three flat colours and no gradients, so each tier's web gradient is
 * flattened to its middle stop.
 *
 * The gold label colour is deliberately darker than the web token `#a9793f`, which only
 * reaches 2.9:1 against the flattened background — below WCAG AA. `rgb(125, 85, 39)` is
 * about 4.95:1.
 */
const THEMES: Record<LoyaltyTier, ApplePassTheme> = {
  gold: {
    backgroundColor: "rgb(241, 220, 205)",
    foregroundColor: "rgb(61, 43, 40)",
    labelColor: "rgb(125, 85, 39)"
  },
  diamond: {
    backgroundColor: "rgb(42, 46, 53)",
    foregroundColor: "rgb(243, 245, 248)",
    labelColor: "rgb(207, 212, 220)"
  }
};

export const resolveAppleTheme = (tier: LoyaltyTier): ApplePassTheme => THEMES[tier];
