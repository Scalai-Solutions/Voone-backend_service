import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Throwaway certificate chain standing in for Apple's. The leaf mirrors the subject layout
 * of a real Pass Type ID certificate (UID = passTypeIdentifier, OU = teamIdentifier) so the
 * production code reads those identifiers off the certificate exactly as it will in production.
 */
export const TEST_PASS_TYPE_IDENTIFIER = "pass.com.voone.loyalty.test";
export const TEST_TEAM_IDENTIFIER = "ABCDE12345";
export const TEST_KEY_PASSPHRASE = "voone-test-passphrase";

export const TEST_CERT_DIR = path.join(__dirname, "..", ".tmp", "certs");

export interface TestChainPaths {
  caCertPath: string;
  signerCertPath: string;
  signerKeyPath: string;
}

export const testChainPaths = (): TestChainPaths => ({
  caCertPath: path.join(TEST_CERT_DIR, "wwdr.pem"),
  signerCertPath: path.join(TEST_CERT_DIR, "signerCert.pem"),
  signerKeyPath: path.join(TEST_CERT_DIR, "signerKey.pem")
});

/**
 * Resolved through OPENSSL_BIN so a shadowing build on PATH cannot silently change
 * behaviour. Some builds — miniconda's among them — refuse to read an *encrypted* key
 * without a console even when the passphrase is supplied on the command line, so this
 * suite never asks OpenSSL to do that: the leaf key is encrypted by node:crypto after
 * the certificate is signed.
 */
export const opensslBin = (): string => process.env.OPENSSL_BIN ?? "openssl";

const openssl = (args: string[], input?: Buffer): Buffer =>
  execFileSync(opensslBin(), args, { input, stdio: ["pipe", "pipe", "pipe"] });

export const assertOpensslAvailable = (): void => {
  let version: string;

  try {
    version = openssl(["version"]).toString("utf8").trim();
  } catch (error) {
    throw new Error(
      `Unable to run "${opensslBin()}". This suite signs and verifies passes with the OpenSSL ` +
        `CLI. Install it or set OPENSSL_BIN. Cause: ${String(error)}`
    );
  }

  if (!/^(OpenSSL 3|LibreSSL)/.test(version)) {
    throw new Error(`Unsupported OpenSSL: "${version}". OpenSSL 3.x or LibreSSL is required.`);
  }
};

export const generateTestChain = (): TestChainPaths => {
  const paths = testChainPaths();

  mkdirSync(TEST_CERT_DIR, { recursive: true });

  const caKeyPath = path.join(TEST_CERT_DIR, "ca.key");
  const plainKeyPath = path.join(TEST_CERT_DIR, "signerKey.plain.pem");
  const csrPath = path.join(TEST_CERT_DIR, "signer.csr");
  const extPath = path.join(TEST_CERT_DIR, "leaf.ext");

  // Certificate authority, standing in for the Apple WWDR intermediate.
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "2",
    "-noenc",
    "-keyout",
    caKeyPath,
    "-out",
    paths.caCertPath,
    "-subj",
    "/C=US/O=Voone Test/CN=Voone Test WWDR CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign"
  ]);

  // Leaf key, unencrypted for now so OpenSSL can build the CSR without a passphrase.
  openssl(["genrsa", "-traditional", "-out", plainKeyPath, "2048"]);

  openssl([
    "req",
    "-new",
    "-key",
    plainKeyPath,
    "-out",
    csrPath,
    "-subj",
    `/UID=${TEST_PASS_TYPE_IDENTIFIER}/CN=Pass Type ID: ${TEST_PASS_TYPE_IDENTIFIER}` +
      `/OU=${TEST_TEAM_IDENTIFIER}/O=Voone Test/C=ES`
  ]);

  // 1.2.840.113635.100.4.3 is Apple's Pass Type ID extended key usage. Nothing in the
  // signing path reads it; it is here so the fixture matches the real certificate shape,
  // and so signature verification exercises the same "-purpose any" path production will.
  writeFileSync(
    extPath,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=1.2.840.113635.100.4.3",
      ""
    ].join("\n")
  );

  openssl([
    "x509",
    "-req",
    "-in",
    csrPath,
    "-sha256",
    "-days",
    "2",
    "-CA",
    paths.caCertPath,
    "-CAkey",
    caKeyPath,
    "-set_serial",
    "1",
    "-extfile",
    extPath,
    "-out",
    paths.signerCertPath
  ]);

  // Encrypt the leaf key the way `openssl rsa -traditional -aes256` would, so the suite
  // exercises the encrypted-key path production uses.
  const encryptedKey = createPrivateKey(readFileSync(plainKeyPath, "utf8")).export({
    type: "pkcs1",
    format: "pem",
    cipher: "aes-256-cbc",
    passphrase: TEST_KEY_PASSPHRASE
  });

  writeFileSync(paths.signerKeyPath, encryptedKey);
  rmSync(plainKeyPath, { force: true });

  return paths;
};

export const verifyChain = (caCertPath: string, signerCertPath: string): string =>
  openssl(["verify", "-CAfile", caCertPath, signerCertPath]).toString("utf8").trim();

/**
 * Asserts a detached PKCS#7 signature covers exactly `content` and chains to `caCertPath`.
 * node-forge cannot do this — its PKCS#7 `verify()` is an unimplemented stub — so the
 * OpenSSL CLI is the only option. `-purpose any` is required because the leaf carries
 * Apple's extended key usage rather than an S/MIME one.
 */
export const verifyDetachedSignature = (
  signature: Buffer,
  content: Buffer,
  caCertPath: string
): void => {
  const contentPath = path.join(TEST_CERT_DIR, "verify-content.bin");
  const outPath = path.join(TEST_CERT_DIR, "verify-out.bin");

  writeFileSync(contentPath, content);

  openssl(
    [
      "smime",
      "-verify",
      "-binary",
      "-inform",
      "DER",
      "-content",
      contentPath,
      "-CAfile",
      caCertPath,
      "-purpose",
      "any",
      "-out",
      outPath
    ],
    signature
  );
};

export const readPem = (filePath: string): string => readFileSync(filePath, "utf8");

export const toBase64 = (filePath: string): string => readFileSync(filePath).toString("base64");
