import { isDarkBackground } from "./colour";

/**
 * The logo a card should show, the same on every wallet.
 *
 * A clinic can upload a second logo for dark backgrounds. Which one belongs on the card depends
 * on the card's own colour, not on the wallet: on a dark card the dark-background logo, on a light
 * card the ordinary one, and whichever exists when the other does not. Apple and Google both ask
 * here, so the two cards of one clinic can no longer show different logos.
 */
export const chooseLogoUrl = (template: {
  logoUrl?: string | null;
  logoOnDarkUrl?: string | null;
  backgroundColor: string;
}): string | undefined => {
  const plain = template.logoUrl ?? undefined;
  const onDark = template.logoOnDarkUrl ?? undefined;

  return isDarkBackground(template.backgroundColor) ? (onDark ?? plain) : (plain ?? onDark);
};
