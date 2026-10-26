import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ImageDimensionsError,
  ImageKindInvalidError,
  ImageTooLargeError,
  ImageUnsupportedError
} from "../../src/common/errors/image.errors";
import type { ImageStorage } from "../../src/modules/media/image-storage";
import {
  MAX_IMAGE_BYTES,
  parseImageKind,
  uploadImage,
  validateImage
} from "../../src/modules/media/image-upload.service";
import { makeImage, makeNoisyImage, makeSvg } from "./image-fixtures";

const fakeStorage = () => {
  const puts: Array<{ key: string; bytes: Buffer; contentType: string }> = [];
  const storage: ImageStorage = {
    put: async (key, bytes, contentType) => {
      puts.push({ key, bytes, contentType });

      return { url: `https://cdn.test/${key}` };
    }
  };

  return { storage, puts };
};

const hash16 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

describe("validateImage", () => {
  it.each([
    ["png", "png", "image/png"],
    ["jpeg", "jpg", "image/jpeg"],
    ["webp", "webp", "image/webp"]
  ] as const)("accepts a real %s", async (format, ext, contentType) => {
    const result = await validateImage(await makeImage(format, 48, 32));

    expect(result).toEqual({ format, ext, contentType, width: 48, height: 32 });
  });

  it("accepts the smallest allowed image, 16x16", async () => {
    await expect(validateImage(await makeImage("png", 16, 16))).resolves.toMatchObject({
      width: 16,
      height: 16
    });
  });

  it("rejects an SVG, which can carry script", async () => {
    await expect(validateImage(makeSvg())).rejects.toBeInstanceOf(ImageUnsupportedError);
  });

  it("rejects a GIF", async () => {
    await expect(validateImage(await makeImage("gif"))).rejects.toBeInstanceOf(
      ImageUnsupportedError
    );
  });

  it("rejects an AVIF", async () => {
    await expect(validateImage(await makeImage("avif"))).rejects.toBeInstanceOf(
      ImageUnsupportedError
    );
  });

  it("rejects a text file, whatever it is called", async () => {
    await expect(
      validateImage(Buffer.from("logo.png\nnot really an image"))
    ).rejects.toBeInstanceOf(ImageUnsupportedError);
  });

  it("rejects an empty body", async () => {
    await expect(validateImage(Buffer.alloc(0))).rejects.toBeInstanceOf(ImageUnsupportedError);
  });

  it("rejects a truncated PNG", async () => {
    const png = await makeNoisyImage("png");

    await expect(validateImage(png.subarray(0, Math.floor(png.length / 2)))).rejects.toBeInstanceOf(
      ImageUnsupportedError
    );
  });

  it("rejects a truncated JPEG", async () => {
    const jpeg = await makeNoisyImage("jpeg");

    await expect(
      validateImage(jpeg.subarray(0, Math.floor(jpeg.length / 2)))
    ).rejects.toBeInstanceOf(ImageUnsupportedError);
  });

  it("rejects a 1x1 image as too small", async () => {
    await expect(validateImage(await makeImage("png", 1, 1))).rejects.toBeInstanceOf(
      ImageDimensionsError
    );
  });

  it("rejects an image with one side under 16", async () => {
    await expect(validateImage(await makeImage("png", 200, 15))).rejects.toBeInstanceOf(
      ImageDimensionsError
    );
  });

  it("rejects an image over 40 million pixels without decoding it", async () => {
    // 7000 x 7000 = 49 million, each side within the 10000 limit; solid, so it stays small.
    const huge = await makeImage("png", 7000, 7000);

    expect(huge.length).toBeLessThan(MAX_IMAGE_BYTES);
    await expect(validateImage(huge)).rejects.toBeInstanceOf(ImageDimensionsError);
  });

  it("rejects a side over 10000", async () => {
    await expect(validateImage(await makeImage("png", 10001, 16))).rejects.toBeInstanceOf(
      ImageDimensionsError
    );
  });

  it("accepts a side of exactly 10000", async () => {
    await expect(validateImage(await makeImage("png", 10000, 16))).resolves.toMatchObject({
      width: 10000
    });
  });
});

describe("uploadImage", () => {
  it("stores a clinic image under its own folder, content-addressed, with the detected extension", async () => {
    const { storage, puts } = fakeStorage();
    const bytes = await makeImage("jpeg");

    const result = await uploadImage(
      { scope: { clinicId: "clinic-1" }, kind: "logo", bytes },
      storage
    );

    const key = `clinics/clinic-1/logo-${hash16(bytes)}.jpg`;

    expect(puts).toEqual([{ key, bytes, contentType: "image/jpeg" }]);
    expect(result).toEqual({
      url: `https://cdn.test/${key}`,
      bytes: bytes.length,
      width: 64,
      height: 64,
      contentType: "image/jpeg"
    });
  });

  it("names the extension after the bytes, not after anything the client claimed", async () => {
    const { storage, puts } = fakeStorage();

    // Real WebP bytes: the key ends in .webp however the upload was labelled.
    await uploadImage(
      { scope: { clinicId: "c" }, kind: "hero", bytes: await makeImage("webp") },
      storage
    );

    expect(puts[0]?.key).toMatch(/^clinics\/c\/hero-[0-9a-f]{16}\.webp$/);
  });

  it("gives the same key for the same bytes and another key for changed bytes", async () => {
    const { storage, puts } = fakeStorage();
    const a = await makeImage("png", 64, 64, { r: 1, g: 2, b: 3 });
    const b = await makeImage("png", 64, 64, { r: 9, g: 8, b: 7 });

    await uploadImage({ scope: { clinicId: "c" }, kind: "logo", bytes: a }, storage);
    await uploadImage({ scope: { clinicId: "c" }, kind: "logo", bytes: Buffer.from(a) }, storage);
    await uploadImage({ scope: { clinicId: "c" }, kind: "logo", bytes: b }, storage);

    expect(puts[0]?.key).toBe(puts[1]?.key);
    expect(puts[2]?.key).not.toBe(puts[0]?.key);
  });

  it("puts shared (admin) uploads under shared/ and distinguishes the kinds", async () => {
    const { storage, puts } = fakeStorage();
    const bytes = await makeImage("png");

    await uploadImage({ scope: "shared", kind: "logoOnDark", bytes }, storage);

    expect(puts[0]?.key).toBe(`shared/logoOnDark-${hash16(bytes)}.png`);
  });

  it("refuses more than 5 MB before looking at the bytes, and never stores it", async () => {
    const { storage, puts } = fakeStorage();

    await expect(
      uploadImage(
        { scope: "shared", kind: "logo", bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1) },
        storage
      )
    ).rejects.toBeInstanceOf(ImageTooLargeError);
    expect(puts).toEqual([]);
  });

  it("does not refuse exactly 5 MB on size (it fails as a non-image instead)", async () => {
    const { storage } = fakeStorage();

    await expect(
      uploadImage({ scope: "shared", kind: "logo", bytes: Buffer.alloc(MAX_IMAGE_BYTES) }, storage)
    ).rejects.toBeInstanceOf(ImageUnsupportedError);
  });

  it("stores nothing when validation fails", async () => {
    const { storage, puts } = fakeStorage();

    await expect(
      uploadImage({ scope: "shared", kind: "logo", bytes: makeSvg() }, storage)
    ).rejects.toBeInstanceOf(ImageUnsupportedError);
    expect(puts).toEqual([]);
  });

  it("refuses a clinic id that could escape its folder", async () => {
    const { storage, puts } = fakeStorage();

    await expect(
      uploadImage(
        { scope: { clinicId: "../shared" }, kind: "logo", bytes: await makeImage("png") },
        storage
      )
    ).rejects.toThrow();
    expect(puts).toEqual([]);
  });
});

describe("parseImageKind", () => {
  it.each(["logo", "logoOnDark", "hero"])("accepts %s", (kind) => {
    expect(parseImageKind(kind)).toBe(kind);
  });

  it.each([undefined, "", "banner", "LOGO", ["logo", "hero"], 5])("rejects %s", (kind) => {
    expect(() => parseImageKind(kind)).toThrow(ImageKindInvalidError);
  });
});
