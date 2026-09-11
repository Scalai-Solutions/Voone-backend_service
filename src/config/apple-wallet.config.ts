import { X509Certificate, createPrivateKey } from "node:crypto";
import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

import { WalletConfigurationError } from "../common/errors/wallet.errors";

/**
 * Apple Wallet signing material is a *feature* precondition, not a process-wide one, so it
 * is parsed here rather than in `config/env.ts` — that module throws at import time, and a
 * backend without a pass certificate must still boot, migrate, and serve health checks.
 * Parsing is lazy and memoized; the first pass build is what surfaces a misconfiguration.
 */
dotenv.config({ quiet: true });

/** Empty strings are what most platforms hand back for an unset variable. */
const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const appleWalletEnvSchema = z.object({
  APPLE_WALLET_ORGANIZATION_NAME: z.string().min(1, "is required"),
  APPLE_WALLET_SIGNER_CERT_BASE64: z.string().min(1, "is required"),
  APPLE_WALLET_SIGNER_KEY_BASE64: z.string().min(1, "is required"),
  APPLE_WALLET_WWDR_CERT_BASE64: z.string().min(1, "is required"),
  APPLE_WALLET_SIGNER_KEY_PASSPHRASE: optionalString,
  APPLE_WALLET_PASS_TYPE_IDENTIFIER: optionalString,
  APPLE_WALLET_TEAM_IDENTIFIER: optionalString,
  APPLE_WALLET_PASS_MODEL_DIR: optionalString
});

export interface AppleWalletCertificates {
  wwdr: Buffer;
  signerCert: Buffer;
  signerKey: Buffer;
  signerKeyPassphrase?: string;
}

export interface AppleWalletConfig {
  passTypeIdentifier: string;
  teamIdentifier: string;
  organizationName: string;
  modelDirectory?: string;
  certificates: AppleWalletCertificates;
}

export interface CertificateIdentifiers {
  passTypeIdentifier: string;
  teamIdentifier: string;
}

const PEM_BEGIN = "-----BEGIN ";
const PEM_END = "-----END ";

/**
 * `Buffer.from(value, "base64")` ignores characters outside the base64 alphabet rather than
 * throwing, so a truncated or mangled variable decodes to plausible-looking garbage. The PEM
 * structure check is what actually catches that, and the label check catches the certificate
 * and key variables being swapped.
 *
 * Error messages name the variable and never include its value.
 */
const decodePemVariable = (name: string, value: string, expectedLabel: string): Buffer => {
  const trimmed = value.trim();
  const decoded = trimmed.startsWith(PEM_BEGIN)
    ? Buffer.from(trimmed, "utf8")
    : Buffer.from(trimmed, "base64");
  const text = decoded.toString("utf8");

  if (!text.includes(PEM_BEGIN) || !text.includes(PEM_END)) {
    throw new WalletConfigurationError(`${name} must be a base64 encoded PEM document`);
  }

  // The label may carry an algorithm qualifier, e.g. "RSA PRIVATE KEY" or
  // "ENCRYPTED PRIVATE KEY", so match the qualifier rather than requiring a bare label.
  const labelPattern = new RegExp(`${PEM_BEGIN}(?:[A-Z0-9]+ )*${expectedLabel}-----`);

  if (!labelPattern.test(text)) {
    throw new WalletConfigurationError(`${name} must contain a "${expectedLabel}" PEM block`);
  }

  return decoded;
};

/** Apple encodes the pass type identifier as the subject UID and the team as the OU. */
const subjectAttributes = (subject: string): Record<string, string> => {
  const entries = subject.split("\n").flatMap((line) => {
    const separator = line.indexOf("=");

    return separator === -1
      ? []
      : [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const];
  });

  return Object.fromEntries(entries);
};

/**
 * Catches the certificate failures that are otherwise silent: a wrong passphrase, a
 * certificate and key that are not a pair, an authority that did not issue the leaf, and an
 * expired certificate. Each of those produces a pass that builds cleanly and is then
 * rejected by every device, so checking here is what turns days of device-side debugging
 * into one clear message.
 */
export const preflightCertificates = (
  certificates: AppleWalletCertificates
): CertificateIdentifiers => {
  let leaf: X509Certificate;
  let authority: X509Certificate;

  try {
    leaf = new X509Certificate(certificates.signerCert);
  } catch (error) {
    throw new WalletConfigurationError(
      "APPLE_WALLET_SIGNER_CERT_BASE64 is not a readable X.509 certificate",
      error
    );
  }

  try {
    authority = new X509Certificate(certificates.wwdr);
  } catch (error) {
    throw new WalletConfigurationError(
      "APPLE_WALLET_WWDR_CERT_BASE64 is not a readable X.509 certificate",
      error
    );
  }

  let privateKey;

  try {
    privateKey = createPrivateKey({
      key: certificates.signerKey,
      passphrase: certificates.signerKeyPassphrase
    });
  } catch (error) {
    throw new WalletConfigurationError(
      "APPLE_WALLET_SIGNER_KEY_BASE64 could not be decrypted. Check " +
        "APPLE_WALLET_SIGNER_KEY_PASSPHRASE — the signing library fails silently on a wrong " +
        "passphrase, so this is checked up front.",
      error
    );
  }

  if (!leaf.checkPrivateKey(privateKey)) {
    throw new WalletConfigurationError(
      "APPLE_WALLET_SIGNER_CERT_BASE64 and APPLE_WALLET_SIGNER_KEY_BASE64 are not a pair. " +
        "A pass signed with a mismatched key builds successfully and is rejected by every device."
    );
  }

  if (!leaf.checkIssued(authority)) {
    throw new WalletConfigurationError(
      `APPLE_WALLET_WWDR_CERT_BASE64 did not issue the signing certificate. The signing ` +
        `certificate reports issuer "${leaf.issuer.replace(/\n/g, ", ")}" — check the Apple ` +
        `WWDR generation.`
    );
  }

  const now = Date.now();

  if (new Date(leaf.validTo).getTime() < now) {
    throw new WalletConfigurationError(
      `The signing certificate expired on ${leaf.validTo}. Passes signed with it are rejected.`
    );
  }

  if (new Date(leaf.validFrom).getTime() > now) {
    throw new WalletConfigurationError(
      `The signing certificate is not valid until ${leaf.validFrom}.`
    );
  }

  const attributes = subjectAttributes(leaf.subject);
  const passTypeIdentifier = attributes.UID;
  const teamIdentifier = attributes.OU;

  if (!passTypeIdentifier || !teamIdentifier) {
    throw new WalletConfigurationError(
      "The signing certificate subject is missing a UID (pass type identifier) or OU (team " +
        "identifier). Apple's Pass Type ID certificates carry both."
    );
  }

  return { passTypeIdentifier, teamIdentifier };
};

/**
 * Pure over its input so every failure mode is testable without touching `process.env`.
 */
export const parseAppleWalletConfig = (source: NodeJS.ProcessEnv): AppleWalletConfig => {
  const parsed = appleWalletEnvSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")} ${issue.message}`)
      .join("; ");

    throw new WalletConfigurationError(`Apple Wallet is not configured: ${details}`);
  }

  const env = parsed.data;

  const certificates: AppleWalletCertificates = {
    wwdr: decodePemVariable(
      "APPLE_WALLET_WWDR_CERT_BASE64",
      env.APPLE_WALLET_WWDR_CERT_BASE64,
      "CERTIFICATE"
    ),
    signerCert: decodePemVariable(
      "APPLE_WALLET_SIGNER_CERT_BASE64",
      env.APPLE_WALLET_SIGNER_CERT_BASE64,
      "CERTIFICATE"
    ),
    signerKey: decodePemVariable(
      "APPLE_WALLET_SIGNER_KEY_BASE64",
      env.APPLE_WALLET_SIGNER_KEY_BASE64,
      "PRIVATE KEY"
    ),
    signerKeyPassphrase: env.APPLE_WALLET_SIGNER_KEY_PASSPHRASE
  };

  const identifiers = preflightCertificates(certificates);

  warnOnIdentifierMismatch(
    "APPLE_WALLET_PASS_TYPE_IDENTIFIER",
    env.APPLE_WALLET_PASS_TYPE_IDENTIFIER,
    identifiers.passTypeIdentifier
  );
  warnOnIdentifierMismatch(
    "APPLE_WALLET_TEAM_IDENTIFIER",
    env.APPLE_WALLET_TEAM_IDENTIFIER,
    identifiers.teamIdentifier
  );

  return {
    ...identifiers,
    organizationName: env.APPLE_WALLET_ORGANIZATION_NAME,
    modelDirectory: env.APPLE_WALLET_PASS_MODEL_DIR
      ? path.resolve(env.APPLE_WALLET_PASS_MODEL_DIR)
      : undefined,
    certificates
  };
};

/**
 * The certificate is the source of truth — it is what Apple validates against. A configured
 * value that disagrees means the wrong certificate is deployed, which is worth saying out
 * loud without failing a boot that would otherwise work.
 */
const warnOnIdentifierMismatch = (
  name: string,
  configured: string | undefined,
  fromCertificate: string
): void => {
  if (configured && configured !== fromCertificate) {
    console.warn(
      `${name} is set to "${configured}" but the signing certificate says ` +
        `"${fromCertificate}". Using the certificate value.`
    );
  }
};

let cachedConfig: AppleWalletConfig | undefined;

export const getAppleWalletConfig = (): AppleWalletConfig => {
  cachedConfig ??= parseAppleWalletConfig(process.env);

  return cachedConfig;
};

export const isAppleWalletConfigured = (): boolean => {
  try {
    getAppleWalletConfig();

    return true;
  } catch {
    return false;
  }
};
