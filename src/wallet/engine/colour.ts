import { hexColorSchema } from "./loyalty-card";

export type Rgb = readonly [number, number, number];

const RGB_FUNCTION = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;

/**
 * Accepts both the hex a clinic template stores and the `rgb()` form this module emits, so
 * a derived theme can be fed straight back into contrastRatio.
 */
export const parseColor = (color: string): Rgb => {
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
export const relativeLuminance = ([r, g, b]: Rgb): number => {
  const linear = [r, g, b].map((channel) => {
    const c = channel / 255;

    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};

/**
 * Whether white text reads better than black on this colour: below the luminance (about 0.179)
 * where the two contrast ratios cross. What decides which logo variant a card should show.
 */
export const isDarkBackground = (color: string): boolean =>
  relativeLuminance(parseColor(color)) < 0.179;
