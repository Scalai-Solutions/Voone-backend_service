import sharp from "sharp";

import { ImageDimensionsError } from "../../common/errors/image.errors";
import type { ImageKind } from "./image-upload.service";

/**
 * What a card image has to look like to show well in a wallet, checked when it is uploaded.
 *
 * The numbers come from Apple's Wallet guide (sizes are in points; a phone draws 1, 2 or 3 pixels
 * per point, so the sharpest version is three times the point size):
 *   - logo: drawn in a 160 × 50 pt box at the top left, "in most cases narrower" → 480 × 150 px at 3×
 *   - strip (our hero): behind the points, 375 pt wide and about 123 pt tall → 1125 × 369 px at 3×
 *   - icon: 29 × 29 pt, which we make from the logo ourselves
 * Google shows the logo in a circle and the hero at about 3:1 (1032 × 336), so a transparent logo
 * with some margin and a hero with its subject in the middle suit both.
 *
 * Apple scales an image to fill its box and crops what does not fit, so nothing here rejects an
 * odd shape: it is handled when the pass is built (logos trimmed and fitted, the hero cropped).
 * Only what cannot be repaired later is refused, and what can only be improved by the clinic is a
 * warning shown next to the upload. Messages are for the clinic, so they are Spanish.
 */

/** Smallest long side of a logo we accept: below it even a 1× phone would show it blurred. */
const LOGO_MIN_LONG_SIDE = 160;
/** A logo this wide or this tall for its size would be a sliver in the 160 × 50 pt box. */
const LOGO_MAX_WIDE = 8;
const LOGO_MAX_TALL = 4;
/** Sharp on a 3× iPhone: the logo box at 3×. */
const LOGO_SHARP = { width: 480, height: 150 };

/** Narrowest hero we accept: the strip at 2×. */
const HERO_MIN_WIDTH = 750;
/** The strip at 3×. */
const HERO_SHARP = { width: 1125, height: 369 };
/** The range of shapes that crop only a little: Google's 3:1 up to a little past Apple's 3.05:1. */
const HERO_RATIO = { min: 2.4, max: 4.2 };

const CORNER_ALPHA_OPAQUE = 250;

/** True when the picture has a solid background: no transparency, or opaque in all four corners. */
const hasSolidBackground = async (bytes: Buffer): Promise<boolean> => {
  const { data, info } = await sharp(bytes)
    .rotate()
    .resize(64, 64, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
  const right = info.width - 1;
  const bottom = info.height - 1;

  return [alphaAt(0, 0), alphaAt(right, 0), alphaAt(0, bottom), alphaAt(right, bottom)].every(
    (alpha) => alpha >= CORNER_ALPHA_OPAQUE
  );
};

const assessLogo = async (bytes: Buffer, width: number, height: number): Promise<string[]> => {
  if (Math.max(width, height) < LOGO_MIN_LONG_SIDE) {
    throw new ImageDimensionsError(
      `El logo es demasiado pequeño (${width}×${height} px). Usa al menos ${LOGO_MIN_LONG_SIDE} px en su lado más largo; lo ideal es ${LOGO_SHARP.width}×${LOGO_SHARP.height} px.`
    );
  }

  if (width / height > LOGO_MAX_WIDE || height / width > LOGO_MAX_TALL) {
    throw new ImageDimensionsError(
      `El logo es demasiado alargado (${width}×${height} px): se vería diminuto en la tarjeta. Usa una proporción de entre 1:${LOGO_MAX_TALL} y ${LOGO_MAX_WIDE}:1, mejor cercana a 3:1 o cuadrada.`
    );
  }

  const warnings: string[] = [];

  // Fitting the logo into the 3× box only enlarges it when it is smaller than the box both ways.
  if (width < LOGO_SHARP.width && height < LOGO_SHARP.height) {
    warnings.push(
      `El logo es pequeño para las pantallas Retina y se verá borroso. Lo ideal es ${LOGO_SHARP.width}×${LOGO_SHARP.height} px (o 660×660 px para Google Wallet).`
    );
  }

  if (await hasSolidBackground(bytes)) {
    warnings.push(
      "El logo tiene un fondo sólido. Sube un PNG con fondo transparente o se verá un recuadro sobre el color de la tarjeta."
    );
  }

  return warnings;
};

const assessHero = (width: number, height: number): string[] => {
  if (width < HERO_MIN_WIDTH) {
    throw new ImageDimensionsError(
      `La imagen es demasiado pequeña (${width}×${height} px). Usa al menos ${HERO_MIN_WIDTH} px de ancho; lo ideal es ${HERO_SHARP.width}×${HERO_SHARP.height} px.`
    );
  }

  const warnings: string[] = [];
  const ratio = width / height;

  if (width < HERO_SHARP.width) {
    warnings.push(
      `Para que se vea nítida en iPhone usa al menos ${HERO_SHARP.width} px de ancho (lo ideal es ${HERO_SHARP.width}×${HERO_SHARP.height} px).`
    );
  }

  if (ratio < HERO_RATIO.min || ratio > HERO_RATIO.max) {
    warnings.push(
      `La tarjeta muestra una franja de proporción aproximada 3:1 (${HERO_SHARP.width}×${HERO_SHARP.height} px), así que esta imagen se recortará. Deja lo importante en el centro.`
    );
  }

  return warnings;
};

/**
 * Refuses an image the wallets cannot show well (throws `ImageDimensionsError` with a message the
 * clinic can act on) and returns warnings for one they can show but not at its best.
 */
export const assessImage = async (
  kind: ImageKind,
  bytes: Buffer,
  size: { width: number; height: number }
): Promise<string[]> =>
  kind === "hero"
    ? assessHero(size.width, size.height)
    : assessLogo(bytes, size.width, size.height);
