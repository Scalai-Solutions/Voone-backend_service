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

/**
 * Whether any of the card's images is one of the borrowed defaults. Wider than `hasOwnLogo`:
 * a clinic can have its own logo and still show another client's hero image or dark logo.
 */
export const usesBorrowedImages = (template: {
  logoUrl: string | null;
  logoOnDarkUrl: string | null;
  heroImageUrl: string | null;
}): boolean =>
  [template.logoUrl, template.logoOnDarkUrl, template.heroImageUrl].some((url) => {
    const trimmed = url?.trim();

    return trimmed !== undefined && trimmed !== "" && BORROWED_DEFAULT_IMAGE_URLS.includes(trimmed);
  });
