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
