import {
  BORROWED_DEFAULT_HERO_IMAGE_URL,
  BORROWED_DEFAULT_LOGO_URL
} from "./default-voone-template";

/**
 * Images that once shipped as the card's fallbacks. They belong to a single client (the
 * Sapphira pilot), so a clinic whose card still carries one is showing someone else's
 * branding. Compared by exact URL, not by host: a clinic's own image uploaded to the same
 * image host is genuine and must not be flagged.
 */
export const BORROWED_DEFAULT_IMAGE_URLS: readonly string[] = [
  BORROWED_DEFAULT_LOGO_URL,
  BORROWED_DEFAULT_HERO_IMAGE_URL
];

/**
 * Whether the card carries a logo that is the clinic's own: not missing, not blank, not
 * the plain Voone logo used when a clinic has none, and not a borrowed image.
 */
export const hasOwnLogo = (
  template: { logoUrl: string | null },
  defaultLogoUrl?: string
): boolean => {
  const logoUrl = template.logoUrl?.trim();

  if (!logoUrl) return false;
  if (defaultLogoUrl && logoUrl === defaultLogoUrl.trim()) return false;

  return !BORROWED_DEFAULT_IMAGE_URLS.includes(logoUrl);
};
