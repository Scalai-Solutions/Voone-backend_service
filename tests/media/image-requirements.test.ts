import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { ImageDimensionsError } from "../../src/common/errors/image.errors";
import { assessImage } from "../../src/modules/media/image-requirements";
import { makeImage } from "./image-fixtures";

/** A PNG with a transparent canvas and an opaque block in the middle, like a real logo. */
const transparentLogo = (width: number, height: number): Promise<Buffer> =>
  sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([
      {
        input: {
          create: {
            width: Math.round(width / 2),
            height: Math.round(height / 2),
            channels: 4,
            background: { r: 30, g: 40, b: 120, alpha: 1 }
          }
        },
        gravity: "centre"
      }
    ])
    .png()
    .toBuffer();

const assess = async (kind: "logo" | "logoOnDark" | "hero", bytes: Buffer) => {
  const { width, height } = await sharp(bytes).metadata();

  return assessImage(kind, bytes, { width: width!, height: height! });
};

describe("a logo", () => {
  it("is accepted without warnings when it is sharp enough and transparent", async () => {
    expect(await assess("logo", await transparentLogo(480, 150))).toEqual([]);
    expect(await assess("logoOnDark", await transparentLogo(660, 660))).toEqual([]);
  });

  it("is refused when its long side is under 160 px", async () => {
    await expect(assess("logo", await transparentLogo(150, 50))).rejects.toBeInstanceOf(
      ImageDimensionsError
    );
    await expect(assess("logo", await transparentLogo(150, 50))).rejects.toThrow(
      /demasiado pequeño/
    );
  });

  it("is refused when it is a sliver: wider than 8:1 or taller than 4:1", async () => {
    await expect(assess("logo", await transparentLogo(1600, 100))).rejects.toThrow(/alargado/);
    await expect(assess("logo", await transparentLogo(200, 900))).rejects.toThrow(/alargado/);
  });

  it("warns that it will be blurry on Retina when smaller than the 3× box both ways", async () => {
    const warnings = await assess("logo", await transparentLogo(320, 100));

    expect(warnings).toEqual([expect.stringContaining("borroso")]);
  });

  it("does not warn about blur when one side reaches the 3× box", async () => {
    expect(await assess("logo", await transparentLogo(600, 120))).toEqual([]);
    // A square logo is limited by the box's 150 px height, which 200 px already exceeds.
    expect(await assess("logo", await transparentLogo(200, 200))).toEqual([]);
    expect(await assess("logo", await transparentLogo(160, 120))).toEqual([
      expect.stringContaining("borroso")
    ]);
    expect(await assess("logo", await transparentLogo(300, 600))).toEqual([]);
  });

  it("warns about a solid background, in a JPEG and in a PNG with opaque corners", async () => {
    expect(await assess("logo", await makeImage("jpeg", 480, 160))).toEqual([
      expect.stringContaining("fondo sólido")
    ]);
    expect(await assess("logo", await makeImage("png", 480, 160))).toEqual([
      expect.stringContaining("fondo sólido")
    ]);
  });
});

describe("a hero image", () => {
  it("is accepted without warnings at the strip's 3× size", async () => {
    expect(await assess("hero", await makeImage("jpeg", 1125, 369))).toEqual([]);
    expect(await assess("hero", await makeImage("jpeg", 1032, 336))).toEqual([
      expect.stringContaining("nítida")
    ]);
  });

  it("is refused when narrower than 750 px", async () => {
    await expect(assess("hero", await makeImage("jpeg", 700, 230))).rejects.toThrow(
      /demasiado pequeña/
    );
  });

  it("warns that it will be cropped when its shape is far from 3:1", async () => {
    const square = await assess("hero", await makeImage("jpeg", 1200, 1200));
    const wide = await assess("hero", await makeImage("jpeg", 2400, 400));

    expect(square).toEqual([expect.stringContaining("se recortará")]);
    expect(wide).toEqual([expect.stringContaining("se recortará")]);
  });

  it("warns about blur below 1125 px, even at the minimum", async () => {
    expect(await assess("hero", await makeImage("jpeg", 750, 246))).toEqual([
      expect.stringContaining("nítida")
    ]);
  });
});
