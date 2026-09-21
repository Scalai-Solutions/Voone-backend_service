import { hexColorSchema } from "../../engine/loyalty-card";

export interface ApplePassTheme {
  backgroundColor: string;
  foregroundColor: string;
  labelColor: string;
}

/**
 * Candidate foreground inks in order of preference.
 *
 * The first two are the ones the web pass preview uses, so a pass and its on-screen preview
 * agree — kept in sync with textColorFor() in the frontend's template form. They are tried
 * first to preserve the intended look, but they only reach about 3.9:1 on a mid-tone
 * background, so pure black and white follow as a guaranteed fallback: one of those always
 * clears AA for any background (the worst case, around relative luminance 0.179, still
 * yields ~4.58:1).
 */
const INK_CANDIDATES = ["#2b211c", "#fff9f2", "#000000", "#ffffff"] as const;

/** WCAG AA for normal text. */
export const MIN_CONTRAST = 4.5;

/**
 * How far a label colour may be muted toward the background, most muted first. A label that
 * reads as secondary is the goal, but not at the cost of contrast, so the first step that
 * still clears AA wins and 0 (label identical to foreground) is the floor.
 */
const LABEL_MUTING_STEPS = [0.45, 0.35, 0.25, 0.15, 0];

type Rgb = readonly [number, number, number];

const RGB_FUNCTION = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;

/**
 * Accepts both the hex a clinic template stores and the `rgb()` form this module emits, so
 * a derived theme can be fed straight back into contrastRatio.
 */
const parseColor = (color: string): Rgb => {
  const functional = RGB_FUNCTION.exec(color.trim());

  if (functional) {
    const channels = [functional[1], functional[2], functional[3]].map(Number);

    if (channels.some((channel) => channel > 255)) {
      throw new Error(`Channel out of range in "${color}"`);
    }

    return [channels[0], channels[1], channels[2]];
  }

  const parsed = hexColorSchema.safeParse(color);

  if (!parsed.success) {
    throw new Error(`Not a hex colour or rgb() value: "${color}"`);
  }

  const body = parsed.data.slice(1);
  const full =
    body.length === 3
      ? body
          .split("")
          .map((c) => c + c)
          .join("")
      : body;

  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16)
  ];
};

/** WCAG relative luminance. */
const relativeLuminance = ([r, g, b]: Rgb): number => {
  const linear = [r, g, b].map((channel) => {
    const c = channel / 255;

    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};

const ratio = (a: Rgb, b: Rgb): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);

  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/**
 * Contrast ratio between two colours, each hex or `rgb()`. Exported for tests and for the
 * admin UI, which needs to warn a clinic before it saves an unreadable colour.
 */
export const contrastRatio = (a: string, b: string): number => ratio(parseColor(a), parseColor(b));

const mix = (from: Rgb, to: Rgb, amount: number): Rgb => [
  Math.round(from[0] + (to[0] - from[0]) * amount),
  Math.round(from[1] + (to[1] - from[1]) * amount),
  Math.round(from[2] + (to[2] - from[2]) * amount)
];

const toRgbString = ([r, g, b]: Rgb): string => `rgb(${r}, ${g}, ${b})`;

/**
 * Derives the three flat colours a storeCard supports from a clinic's chosen background.
 *
 * A clinic can pick any colour, so the readable foreground cannot be hardcoded — it is the
 * first candidate ink that clears AA, and the label is muted only as far as AA allows.
 * Gradients are not expressible on a storeCard at all, which is why a single background
 * colour is all this takes.
 */
export const deriveAppleTheme = (hexBackgroundColor: string): ApplePassTheme => {
  const background = parseColor(hexBackgroundColor);

  const inks = INK_CANDIDATES.map(parseColor);

  // First ink that clears AA, falling back to whichever has the most contrast if — against
  // the arithmetic above — none does.
  const foreground =
    inks.find((ink) => ratio(ink, background) >= MIN_CONTRAST) ??
    inks.reduce((best, ink) => (ratio(ink, background) > ratio(best, background) ? ink : best));

  const label =
    LABEL_MUTING_STEPS.map((step) => mix(foreground, background, step)).find(
      (candidate) => ratio(candidate, background) >= MIN_CONTRAST
    ) ?? foreground;

  return {
    backgroundColor: toRgbString(background),
    foregroundColor: toRgbString(foreground),
    labelColor: toRgbString(label)
  };
};
