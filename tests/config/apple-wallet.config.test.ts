import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseAppleWalletConfig,
  preflightCertificates
} from "../../src/config/apple-wallet.config";
import { WalletConfigurationError } from "../../src/common/errors/wallet.errors";
import {
  TEST_KEY_PASSPHRASE,
  TEST_PASS_TYPE_IDENTIFIER,
  TEST_TEAM_IDENTIFIER,
  readPem,
  testChainPaths,
  toBase64
} from "../helpers/test-certificates";

const paths = testChainPaths();

const validEnv = (): NodeJS.ProcessEnv => ({
  APPLE_WALLET_ORGANIZATION_NAME: "Voone Test",
  APPLE_WALLET_SIGNER_CERT_BASE64: toBase64(paths.signerCertPath),
  APPLE_WALLET_SIGNER_KEY_BASE64: toBase64(paths.signerKeyPath),
  APPLE_WALLET_WWDR_CERT_BASE64: toBase64(paths.caCertPath),
  APPLE_WALLET_SIGNER_KEY_PASSPHRASE: TEST_KEY_PASSPHRASE
});

describe("parseAppleWalletConfig", () => {
  it("decodes base64 PEM into buffers", () => {
    const config = parseAppleWalletConfig(validEnv());

    expect(config.certificates.signerCert).toBeInstanceOf(Buffer);
    expect(config.certificates.signerCert.toString("utf8")).toContain(
      "-----BEGIN CERTIFICATE-----"
    );
    expect(config.certificates.signerKeyPassphrase).toBe(TEST_KEY_PASSPHRASE);
    expect(config.organizationName).toBe("Voone Test");
  });

  it("reads the identifiers off the certificate rather than trusting configuration", () => {
    const config = parseAppleWalletConfig(validEnv());

    expect(config.passTypeIdentifier).toBe(TEST_PASS_TYPE_IDENTIFIER);
    expect(config.teamIdentifier).toBe(TEST_TEAM_IDENTIFIER);
  });

  it("accepts raw PEM as well as base64", () => {
    const config = parseAppleWalletConfig({
      ...validEnv(),
      APPLE_WALLET_SIGNER_CERT_BASE64: readPem(paths.signerCertPath)
    });

    expect(config.passTypeIdentifier).toBe(TEST_PASS_TYPE_IDENTIFIER);
  });

  it("treats an empty passphrase as absent", () => {
    // Railway and similar platforms hand back "" for an unset variable, and the signing
    // library rejects an empty-string passphrase outright.
    expect(() =>
      parseAppleWalletConfig({ ...validEnv(), APPLE_WALLET_SIGNER_KEY_PASSPHRASE: "" })
    ).toThrow(WalletConfigurationError);
  });

  it.each([
    "APPLE_WALLET_ORGANIZATION_NAME",
    "APPLE_WALLET_SIGNER_CERT_BASE64",
    "APPLE_WALLET_SIGNER_KEY_BASE64",
    "APPLE_WALLET_WWDR_CERT_BASE64"
  ])("names %s when it is missing", (variable) => {
    const env = validEnv();
    delete env[variable];

    expect(() => parseAppleWalletConfig(env)).toThrow(WalletConfigurationError);
    expect(() => parseAppleWalletConfig(env)).toThrow(new RegExp(variable));
  });

  it("rejects a value that decodes to something that is not PEM", () => {
    expect(() =>
      parseAppleWalletConfig({
        ...validEnv(),
        APPLE_WALLET_SIGNER_CERT_BASE64: Buffer.from("not a certificate").toString("base64")
      })
    ).toThrow(WalletConfigurationError);
  });

  it("rejects a certificate supplied in the private key slot", () => {
    expect(() =>
      parseAppleWalletConfig({
        ...validEnv(),
        APPLE_WALLET_SIGNER_KEY_BASE64: toBase64(paths.signerCertPath)
      })
    ).toThrow(/APPLE_WALLET_SIGNER_KEY_BASE64/);
  });

  it("never leaks the value of a variable into the error message", () => {
    const secret = toBase64(paths.signerKeyPath);

    try {
      parseAppleWalletConfig({ ...validEnv(), APPLE_WALLET_SIGNER_CERT_BASE64: secret });
      expect.unreachable("expected a configuration error");
    } catch (error) {
      const message = (error as Error).message;

      expect(message).not.toContain(secret);
      expect(message).not.toContain(TEST_KEY_PASSPHRASE);
    }
  });

  it("warns when a configured identifier disagrees with the certificate", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const config = parseAppleWalletConfig({
      ...validEnv(),
      APPLE_WALLET_PASS_TYPE_IDENTIFIER: "pass.com.voone.wrong"
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(config.passTypeIdentifier).toBe(TEST_PASS_TYPE_IDENTIFIER);
  });
});

describe("preflightCertificates", () => {
  const certificates = () => ({
    wwdr: Buffer.from(readPem(paths.caCertPath)),
    signerCert: Buffer.from(readPem(paths.signerCertPath)),
    signerKey: Buffer.from(readPem(paths.signerKeyPath)),
    signerKeyPassphrase: TEST_KEY_PASSPHRASE
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the identifiers encoded in the certificate subject", () => {
    expect(preflightCertificates(certificates())).toEqual({
      passTypeIdentifier: TEST_PASS_TYPE_IDENTIFIER,
      teamIdentifier: TEST_TEAM_IDENTIFIER
    });
  });

  it("rejects a wrong passphrase instead of failing silently at signing time", () => {
    expect(() =>
      preflightCertificates({ ...certificates(), signerKeyPassphrase: "wrong" })
    ).toThrow(WalletConfigurationError);
  });

  it("rejects a certificate and key that are not a pair", () => {
    // The CA key is a different keypair, so this stands in for the classic deployment
    // mistake of pairing a certificate with the wrong key.
    expect(() =>
      preflightCertificates({
        ...certificates(),
        signerCert: Buffer.from(readPem(paths.caCertPath))
      })
    ).toThrow(/not a pair|issuer|subject/i);
  });

  it("rejects an authority that did not issue the leaf", () => {
    expect(() =>
      preflightCertificates({
        ...certificates(),
        wwdr: Buffer.from(readPem(paths.signerCertPath))
      })
    ).toThrow(WalletConfigurationError);
  });
});
