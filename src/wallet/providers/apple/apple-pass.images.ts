import sharp from "sharp";

import { isPublicHttpsUrl } from "../../../common/utils/public-https-url";

export { isPublicHttpsUrl };

/**
 * A clinic's own logo and hero image, as the three sizes an Apple pass needs.
 *
 * Google takes an image URL and fetches it itself. An Apple pass is a signed file, so the
 * pictures have to be inside it, at the sizes the device expects. This is the one place that
 * turns a template's URLs into those files.
 *
 * Images never make a pass fail: a clinic with a broken link still gets a working card with the
 * Voone logo, not no card. A failure returns null and the builder keeps the bundled image.
 */

export interface PassImageSet {
  /** Pass bundle file name → PNG bytes. */
  files: Record<string, Buffer>;
}

export interface PassImageSource {
  logo(url: string): Promise<PassImageSet | null>;
  strip(url: string): Promise<PassImageSet | null>;
}

/** Points, as Apple draws them: a storeCard logo is at most 160×50, its strip 375×98. */
const LOGO = { width: 160, height: 50 };
const STRIP = { width: 375, height: 98 };
const SCALES = [1, 2, 3] as const;

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];

const suffix = (scale: number): string => (scale === 1 ? "" : `@${scale}x`);

const download = async (url: string): Promise<Buffer | null> => {
  if (!isPublicHttpsUrl(url)) return null;

  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });

    if (!response.ok) return null;

    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

    if (!ALLOWED_TYPES.includes(type)) return null;

    const declared = Number(response.headers.get("content-length") ?? 0);

    if (declared > MAX_BYTES) return null;

    const bytes = Buffer.from(await response.arrayBuffer());

    return bytes.length > 0 && bytes.length <= MAX_BYTES ? bytes : null;
  } catch {
    return null;
  }
};

const stripShade = (width: number, height: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
  `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
  `<stop offset="0" stop-color="#000" stop-opacity="0"/>` +
  `<stop offset="1" stop-color="#000" stop-opacity="0.55"/></linearGradient></defs>` +
  `<rect width="100%" height="100%" fill="url(#g)"/></svg>`;

/** Resizes at 1×, 2× and 3×. A logo keeps its shape on a transparent canvas; a strip fills. */
export const renderSizes = async (
  source: Buffer,
  base: { width: number; height: number },
  name: "logo" | "strip",
  fit: "contain" | "cover"
): Promise<PassImageSet> => {
  const files: Record<string, Buffer> = {};

  for (const scale of SCALES) {
    const width = base.width * scale;
    const height = base.height * scale;
    // A logo exported with a wide empty border draws small and off-centre; cut the border first.
    let image = (name === "logo" ? sharp(source).rotate().trim() : sharp(source).rotate()).resize(
      width,
      height,
      {
        fit,
        position: name === "strip" ? "attention" : "centre",
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    );

    // A soft shade up the strip's left and bottom keeps the points number readable over any
    // photo, instead of leaving it to whatever the photo happens to be.
    if (name === "strip") {
      image = image.composite([{ input: Buffer.from(stripShade(width, height)) }]);
    }

    files[`${name}${suffix(scale)}.png`] = await image.png().toBuffer();
  }

  return { files };
};

/**
 * Fetches and resizes, remembering the result so a pass rebuilt on every points change does not
 * download the same logo each time. Keyed by URL: a clinic that changes its image changes the URL.
 */
export class RemotePassImageSource implements PassImageSource {
  private readonly cache = new Map<string, Promise<PassImageSet | null>>();

  constructor(private readonly maxEntries = 200) {}

  logo(url: string): Promise<PassImageSet | null> {
    return this.remember(`logo:${url}`, url, LOGO, "logo", "contain");
  }

  strip(url: string): Promise<PassImageSet | null> {
    return this.remember(`strip:${url}`, url, STRIP, "strip", "cover");
  }

  private remember(
    key: string,
    url: string,
    base: { width: number; height: number },
    name: "logo" | "strip",
    fit: "contain" | "cover"
  ): Promise<PassImageSet | null> {
    const hit = this.cache.get(key);

    if (hit) return hit;

    const work = (async () => {
      const bytes = await download(url);

      if (!bytes) return null;

      try {
        return await renderSizes(bytes, base, name, fit);
      } catch {
        return null;
      }
    })();

    // A failure is not remembered: a clinic fixing its link should not wait for a restart.
    void work.then((result) => {
      if (!result) this.cache.delete(key);
    });

    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;

      if (oldest) this.cache.delete(oldest);
    }

    this.cache.set(key, work);

    return work;
  }
}
