import { randomBytes } from "node:crypto";

import sharp from "sharp";

type Format = "png" | "jpeg" | "webp" | "gif" | "avif";

/** A solid-colour image of the given size, encoded by sharp. */
export const makeImage = async (
  format: Format,
  width = 64,
  height = 64,
  background = { r: 200, g: 30, b: 90 }
): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background } })
    .toFormat(format)
    .toBuffer();

/** A noisy image, so a truncated copy really is missing pixel data. */
export const makeNoisyImage = async (format: "png" | "jpeg" | "webp", size = 128) => {
  const raw = Buffer.alloc(size * size * 3);

  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;

  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .toFormat(format)
    .toBuffer();
};

export const makeSvg = (): Buffer =>
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'
  );

/** A square PNG of random pixels: incompressible, so its size is close to width*width*3. */
export const makeRandomPng = async (size: number): Promise<Buffer> =>
  sharp(randomBytes(size * size * 3), { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();

/** An animated WebP with the given number of identical-sized, different-coloured frames. */
export const makeAnimatedWebp = async (frames = 2, size = 32): Promise<Buffer> => {
  const raw = Buffer.alloc(size * size * 3 * frames);

  for (let frame = 0; frame < frames; frame++) {
    raw.fill(frame * 90 + 20, frame * size * size * 3, (frame + 1) * size * size * 3);
  }

  return sharp(raw, { raw: { width: size, height: size * frames, channels: 3, pageHeight: size } })
    .webp({ loop: 0, delay: new Array<number>(frames).fill(100) })
    .toBuffer();
};
