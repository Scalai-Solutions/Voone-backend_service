import { beforeAll, describe, expect, it } from "vitest";

import { ApplePassBuilder } from "../../src/wallet/providers/apple/apple-pass.builder";
import { resolvePassModelDirectory } from "../../src/wallet/providers/apple/apple-pass.model";
import { WalletPassSigningError } from "../../src/common/errors/wallet.errors";
import { parseAppleWalletConfig } from "../../src/config/apple-wallet.config";
import { aureaGoldPass } from "../fixtures/loyalty-card.fixture";
import { PkpassEntries, readManifest, readPassJson, readPkpass, sha1 } from "../helpers/pkpass";
import {
  TEST_KEY_PASSPHRASE,
  TEST_PASS_TYPE_IDENTIFIER,
  TEST_TEAM_IDENTIFIER,
  testChainPaths,
  toBase64,
  verifyDetachedSignature
} from "../helpers/test-certificates";

const paths = testChainPaths();

const buildBuilder = (modelDirectory = resolvePassModelDirectory()): ApplePassBuilder => {
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
    modelDirectory,
    certificates: config.certificates
  });
};

describe("ApplePassBuilder", () => {
  let buffer: Buffer;
  let entries: PkpassEntries;

  beforeAll(async () => {
    const built = await buildBuilder().build(aureaGoldPass);

    buffer = built.buffer;
    entries = readPkpass(buffer);
  });

  it("returns a zip archive described as a pkpass", async () => {
    const built = await buildBuilder().build(aureaGoldPass);

    expect(built.contentType).toBe("application/vnd.apple.pkpass");
    expect(built.fileName).toBe(`${aureaGoldPass.serialNumber}.pkpass`);
    expect(built.serialNumber).toBe(aureaGoldPass.serialNumber);
    expect(built.buffer.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("bundles the pass, its manifest, its signature and every image", () => {
    expect(Object.keys(entries).sort()).toEqual(
      [
        "en.lproj/pass.strings",
        "icon.png",
        "icon@2x.png",
        "icon@3x.png",
        "logo.png",
        "logo@2x.png",
        "logo@3x.png",
        "manifest.json",
        "pass.json",
        "signature"
      ].sort()
    );
  });

  it("covers exactly the payload files in the manifest", () => {
    const expected = Object.keys(entries)
      .filter((name) => name !== "manifest.json" && name !== "signature")
      .sort();

    expect(Object.keys(readManifest(entries)).sort()).toEqual(expected);
  });

  it("records a correct SHA-1 for every manifest entry", () => {
    for (const [name, digest] of Object.entries(readManifest(entries))) {
      expect(sha1(entries[name]), `digest mismatch for ${name}`).toBe(digest);
    }
  });

  it("signs the manifest with a signature that verifies against the authority", () => {
    expect(() =>
      verifyDetachedSignature(
        Buffer.from(entries["signature"]),
        Buffer.from(entries["manifest.json"]),
        paths.caCertPath
      )
    ).not.toThrow();
  });

  it("fails verification when the manifest is tampered with", () => {
    const tampered = Buffer.from(entries["manifest.json"]);
    tampered[tampered.length - 1] ^= 0xff;

    expect(() =>
      verifyDetachedSignature(Buffer.from(entries["signature"]), tampered, paths.caCertPath)
    ).toThrow();
  });

  it("writes the identifiers taken from the signing certificate", () => {
    const passJson = readPassJson(entries);

    expect(passJson.formatVersion).toBe(1);
    expect(passJson.passTypeIdentifier).toBe(TEST_PASS_TYPE_IDENTIFIER);
    expect(passJson.teamIdentifier).toBe(TEST_TEAM_IDENTIFIER);
    expect(passJson.serialNumber).toBe(aureaGoldPass.serialNumber);
    expect(passJson.description).toBeTruthy();
    expect(passJson.sharingProhibited).toBe(true);
  });

  it("describes a storeCard carrying the mapped fields", () => {
    const storeCard = readPassJson(entries).storeCard as Record<
      string,
      { key: string; label?: string; value: unknown }[]
    >;

    // Points are primary and labelled from the clinic template, not a constant.
    expect(storeCard.primaryFields[0]).toMatchObject({
      key: "points",
      label: "Saldo Beauty",
      value: 1250
    });
    expect(storeCard.headerFields[0]).toMatchObject({ key: "tier", label: "Nivel", value: "Gold" });
    expect(storeCard.secondaryFields.map((field) => field.key)).toEqual(["member"]);
    expect(storeCard.backFields.map((field) => field.key)).toContain("redemptionCode");
    // No column backs credit or reward, so neither is invented.
    expect(storeCard.auxiliaryFields ?? []).toHaveLength(0);
  });

  it("derives the theme from the clinic template background", () => {
    const passJson = readPassJson(entries);

    expect(passJson.backgroundColor).toBe("rgb(241, 220, 205)");
    expect(passJson.foregroundColor).toBe("rgb(43, 33, 28)");
  });

  it("encodes the redemption code as a QR barcode, never the serial number", () => {
    const barcodes = readPassJson(entries).barcodes as {
      message: string;
      format: string;
    }[];

    expect(barcodes[0].format).toBe("PKBarcodeFormatQR");
    expect(barcodes[0].message).toBe(aureaGoldPass.redemptionCode);
    expect(JSON.stringify(barcodes)).not.toContain(aureaGoldPass.serialNumber);
  });

  it("omits web service properties, which are out of scope and must travel together", () => {
    const passJson = readPassJson(entries);

    expect(passJson.webServiceURL).toBeUndefined();
    expect(passJson.authenticationToken).toBeUndefined();
  });

  it("applies the tier theme", () => {
    expect(readPassJson(entries).backgroundColor).toBe("rgb(241, 220, 205)");
  });

  it("preserves Spanish diacritics as UTF-8", () => {
    const text = Buffer.from(entries["pass.json"]).toString("utf8");

    expect(text).toContain("AURÉA");
    expect(text).toContain("CÓDIGO DE CANJE");
    expect(text).toContain("INFORMACIÓN");
  });

  it("ships English translations alongside the Spanish keys", () => {
    const strings = Buffer.from(entries["en.lproj/pass.strings"]).toString("utf8");

    expect(strings).toContain("SOCIA");
    expect(strings).toContain("MEMBER");
  });

  it("reports a missing model directory without leaking key material", async () => {
    const builder = buildBuilder("/tmp/voone-does-not-exist.pass");

    await expect(builder.build(aureaGoldPass)).rejects.toThrow(WalletPassSigningError);
    await expect(builder.build(aureaGoldPass)).rejects.not.toThrow(new RegExp(TEST_KEY_PASSPHRASE));
  });
});
