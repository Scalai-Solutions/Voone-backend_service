import { X509Certificate, createPrivateKey } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  TEST_KEY_PASSPHRASE,
  TEST_PASS_TYPE_IDENTIFIER,
  TEST_TEAM_IDENTIFIER,
  readPem,
  testChainPaths,
  verifyChain
} from "./test-certificates";

describe("test certificate chain", () => {
  const paths = testChainPaths();

  it("produces a leaf that verifies against the test authority", () => {
    expect(verifyChain(paths.caCertPath, paths.signerCertPath)).toContain("OK");
  });

  it("produces a certificate and key that are a pair", () => {
    const leaf = new X509Certificate(readPem(paths.signerCertPath));
    const key = createPrivateKey({
      key: readPem(paths.signerKeyPath),
      passphrase: TEST_KEY_PASSPHRASE
    });

    expect(leaf.checkPrivateKey(key)).toBe(true);
  });

  it("encrypts the private key", () => {
    expect(readPem(paths.signerKeyPath)).toContain("Proc-Type: 4,ENCRYPTED");
  });

  it("rejects the wrong passphrase loudly", () => {
    expect(() =>
      createPrivateKey({ key: readPem(paths.signerKeyPath), passphrase: "wrong" })
    ).toThrow();
  });

  it("carries the Apple identifiers in the subject, so production can read them back", () => {
    const { subject } = new X509Certificate(readPem(paths.signerCertPath));

    expect(subject).toContain(`UID=${TEST_PASS_TYPE_IDENTIFIER}`);
    expect(subject).toContain(`OU=${TEST_TEAM_IDENTIFIER}`);
  });

  it("is issued by the stand-in authority", () => {
    const leaf = new X509Certificate(readPem(paths.signerCertPath));
    const ca = new X509Certificate(readPem(paths.caCertPath));

    expect(leaf.checkIssued(ca)).toBe(true);
  });

  it("exposes the chain to tests as base64 environment variables", () => {
    const encoded = process.env.APPLE_WALLET_SIGNER_CERT_BASE64 ?? "";

    expect(encoded).toBeTruthy();
    expect(Buffer.from(encoded, "base64").toString("utf8")).toContain(
      "-----BEGIN CERTIFICATE-----"
    );
  });
});
