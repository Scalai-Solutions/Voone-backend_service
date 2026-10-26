import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  ImageDimensionsError,
  ImageKindInvalidError,
  ImageTooLargeError,
  ImageUnsupportedError
} from "../../common/errors/image.errors";
import type { ImageStorage } from "./image-storage";

export const IMAGE_KINDS = ["logo", "logoOnDark", "hero"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Decompression-bomb guard: a few KB of PNG can claim billions of pixels. */
const MAX_PIXELS = 40_000_000;
const MAX_SIDE = 10_000;
const MIN_SIDE = 16;

type Format = "png" | "jpeg" | "webp";

const FORMATS: Record<Format, { ext: "png" | "jpg" | "webp"; contentType: string }> = {
  png: { ext: "png", contentType: "image/png" },
  jpeg: { ext: "jpg", contentType: "image/jpeg" },
  webp: { ext: "webp", contentType: "image/webp" }
};

const isAccepted = (format: string | undefined): format is Format =>
  format !== undefined && Object.hasOwn(FORMATS, format);

export interface ValidatedImage {
  format: Format;
  ext: "png" | "jpg" | "webp";
  contentType: string;
  width: number;
  height: number;
}

export interface UploadResult {
  url: string;
  bytes: number;
  width: number;
  height: number;
  contentType: string;
}

export const parseImageKind = (value: unknown): ImageKind => {
  if (typeof value === "string" && (IMAGE_KINDS as readonly string[]).includes(value)) {
    return value as ImageKind;
  }

  throw new ImageKindInvalidError();
};

/**
 * Decides whether the bytes really are an image we accept, from the bytes alone.
 *
 * The client's content type and file name are never consulted: both are chosen by whoever
 * uploads. sharp reads the format and size from the header, which rejects SVG, GIF, AVIF and
 * plain text, and lets the size limits run before anything is decoded. A header can be intact
 * on a file whose pixel data is cut short, so one decode pass at thumbnail size follows; sharp
 * fails on corrupt data by default, and `limitInputPixels` backstops the check above.
 */
export const validateImage = async (bytes: Buffer): Promise<ValidatedImage> => {
  let metadata: sharp.Metadata;

  try {
    // Header only, nothing is decoded: the pixel limit is off here so an oversize image is
    // reported as a size problem below rather than as "not an image".
    metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
  } catch (error) {
    throw new ImageUnsupportedError(error);
  }

  const { format, width, height } = metadata;

  if (!isAccepted(format) || !width || !height) {
    throw new ImageUnsupportedError();
  }

  if (
    width < MIN_SIDE ||
    height < MIN_SIDE ||
    width > MAX_SIDE ||
    height > MAX_SIDE ||
    width * height > MAX_PIXELS
  ) {
    throw new ImageDimensionsError();
  }

  try {
    await sharp(bytes, { limitInputPixels: MAX_PIXELS })
      .resize(32, 32, { fit: "inside" })
      .raw()
      .toBuffer();
  } catch (error) {
    throw new ImageUnsupportedError(error);
  }

  return { format, ...FORMATS[format], width, height };
};

/** Clinic ids are UUIDs; anything else would be a way to write outside the clinic's folder. */
const SAFE_SEGMENT = /^[A-Za-z0-9-]+$/;

const folderFor = (scope: { clinicId: string } | "shared"): string => {
  if (scope === "shared") return "shared";

  if (!SAFE_SEGMENT.test(scope.clinicId)) {
    throw new Error("Refusing an image folder for a malformed clinic id.");
  }

  return `clinics/${scope.clinicId}`;
};

/**
 * Validates and stores an image, returning its public URL.
 *
 * The object key is content-addressed (`<kind>-<first 16 hex of sha256>.<ext>`): uploading
 * the same file again is idempotent, and a changed image gets a new URL, so a wallet that
 * cached the old picture is never served a different one under the same address. Bytes are
 * stored exactly as received, with no re-encoding.
 */
export const uploadImage = async (
  input: { scope: { clinicId: string } | "shared"; kind: ImageKind; bytes: Buffer },
  storage: ImageStorage
): Promise<UploadResult> => {
  const { bytes, kind, scope } = input;

  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageTooLargeError();

  const folder = folderFor(scope);
  const image = await validateImage(bytes);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);

  const { url } = await storage.put(
    `${folder}/${kind}-${hash}.${image.ext}`,
    bytes,
    image.contentType
  );

  return {
    url,
    bytes: bytes.length,
    width: image.width,
    height: image.height,
    contentType: image.contentType
  };
};
