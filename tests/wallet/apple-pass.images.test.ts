import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { ApplePassBuilder } from "../../src/wallet/providers/apple/apple-pass.builder";
import {
  PassImageSource,
  isPublicHttpsUrl,
  renderSizes
} from "../../src/wallet/providers/apple/apple-pass.images";
import { resolvePassModelDirectory } from "../../src/wallet/providers/apple/apple-pass.model";
import { parseAppleWalletConfig } from "../../src/config/apple-wallet.config";
import { aureaGoldPass } from "../fixtures/loyalty-card.fixture";
import { readPkpass } from "../helpers/pkpass";
import { TEST_KEY_PASSPHRASE, testChainPaths, toBase64 } from "../helpers/test-certificates";

const paths = testChainPaths();

const builderWith = (images?: PassImageSource): ApplePassBuilder => {
  const config = parseAppleWalletConfig({
    APPLE_WALLET_ORGANIZATION_NAME: "Voone Test",
    APPLE_WALLET_SIGNER_CERT_BASE64: toBase64(paths.signerCertPath),
    APPLE_WALLET_SIGNER_KEY_BASE64: toBase64(paths.signerKeyPath),
    APPLE_WALLET_WWDR_CERT_BASE64: toBase64(paths.caCertPath),
    APPLE_WALLET_SIGNER_KEY_PASSPHRASE: TEST_KEY_PASSPHRASE
  });

  return new ApplePassBuilder({
    passTypeIdentifier: config.passTypeIdentifier,
    teamIdentifier: config.teamIdentifier,
    organizationName: config.organizationName,
    modelDirectory: resolvePassModelDirectory(),
    certificates: config.certificates,
    images
  });
};

const picture = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#c0392b" } })
    .jpeg()
    .toBuffer();

const dimensions = async (bytes: Buffer) => {
  const { width, height, format } = await sharp(bytes).metadata();

  return { width, height, format };
};

describe("isPublicHttpsUrl", () => {
  it("accepts a public https address", () => {
    expect(isPublicHttpsUrl("https://cdn.example.com/logo.png")).toBe(true);
  });

  it.each([
    "http://cdn.example.com/logo.png",
    "https://localhost/logo.png",
    "https://127.0.0.1/logo.png",
    "https://10.0.0.5/logo.png",
    "https://192.168.1.1/logo.png",
    "https://172.20.0.1/logo.png",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/logo.png",
    "https://intranet/logo.png",
    "https://db.railway.internal/logo.png",
    "file:///etc/passwd",
    "not a url"
  ])("refuses %s", (url) => {
    expect(isPublicHttpsUrl(url)).toBe(false);
  });
});

describe("renderSizes", () => {
  it("makes a logo at 1x, 2x and 3x without distorting it", async () => {
    const set = await renderSizes(
      await picture(400, 400),
      { width: 160, height: 50 },
      "logo",
      "contain"
    );

    expect(Object.keys(set.files).sort()).toEqual(["logo.png", "logo@2x.png", "logo@3x.png"]);
    expect(await dimensions(set.files["logo.png"])).toEqual({
      width: 160,
      height: 50,
      format: "png"
    });
    expect(await dimensions(set.files["logo@3x.png"])).toEqual({
      width: 480,
      height: 150,
      format: "png"
    });
  });

  it("fills the strip at every size", async () => {
    const set = await renderSizes(
      await picture(1600, 900),
      { width: 375, height: 98 },
      "strip",
      "cover"
    );

    expect(await dimensions(set.files["strip@2x.png"])).toEqual({
      width: 750,
      height: 196,
      format: "png"
    });
  });
});

describe("ApplePassBuilder images", () => {
  const set = async (name: "logo" | "strip") =>
    renderSizes(
      await picture(300, 300),
      name === "logo" ? { width: 160, height: 50 } : { width: 375, height: 98 },
      name,
      name === "logo" ? "contain" : "cover"
    );

  it("puts the clinic's logo and hero in the pass in place of the bundled logo", async () => {
    const logo = await set("logo");
    const strip = await set("strip");
    const source: PassImageSource = { logo: async () => logo, strip: async () => strip };

    const built = await builderWith(source).build({
      ...aureaGoldPass,
      template: {
        ...aureaGoldPass.template,
        logoUrl: "https://cdn.example.com/logo.png",
        heroImageUrl: "https://cdn.example.com/hero.jpg"
      }
    });
    const entries = readPkpass(built.buffer);

    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining([
        "logo.png",
        "logo@2x.png",
        "logo@3x.png",
        "strip.png",
        "strip@2x.png",
        "strip@3x.png"
      ])
    );
    expect(Buffer.compare(entries["logo.png"] as Buffer, logo.files["logo.png"])).toBe(0);
  });

  it("keeps the bundled logo and adds no strip when the image cannot be fetched", async () => {
    const source: PassImageSource = { logo: async () => null, strip: async () => null };

    const built = await builderWith(source).build({
      ...aureaGoldPass,
      template: {
        ...aureaGoldPass.template,
        logoUrl: "https://cdn.example.com/broken.png",
        heroImageUrl: "https://cdn.example.com/broken.jpg"
      }
    });
    const names = Object.keys(readPkpass(built.buffer));

    expect(names).toContain("logo.png");
    expect(names).not.toContain("strip.png");
  });

  it("asks for nothing when the template has no images", async () => {
    let asked = 0;
    const source: PassImageSource = {
      logo: async () => (asked++, null),
      strip: async () => (asked++, null)
    };

    await builderWith(source).build({
      ...aureaGoldPass,
      template: { ...aureaGoldPass.template, logoUrl: undefined, heroImageUrl: undefined }
    });

    expect(asked).toBe(0);
  });
});
