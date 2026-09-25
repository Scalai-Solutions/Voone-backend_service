/**
 * Verifies Apple Wallet signing material before it is ever deployed.
 *
 * Apple ships no CLI for Pass Type IDs — the portal is web-only, and the App Store
 * Connect API does not cover pass certificates — so there is nothing to interrogate
 * remotely. What can be checked is the material itself, and every way it can be wrong
 * produces a pass that builds cleanly and is then rejected by every device. That is days
 * of on-device debugging for a fault visible in a second here.
 *
 * It calls the same preflightCertificates() the server calls, deliberately: a separate
 * implementation would drift, and then this would pass while production failed.
 *
 *   npm run apple:check -- --p12 ./Certificates.p12 --wwdr ./AppleWWDRCAG4.pem
 *   npm run apple:check -- --cert ./signerCert.pem --key ./signerKey.pem --wwdr ./wwdr.pem
 *
 * The passphrase is read from APPLE_WALLET_SIGNER_KEY_PASSPHRASE, never from an argument:
 * arguments are visible to every process on the machine via ps.
 *
 * Nothing secret is printed. Only identifiers and dates, all of which travel inside every
 * pass anyway.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import {
  RENEWAL_WARNING_DAYS,
  certificateStatus,
  preflightCertificates,
  type AppleWalletCertificates
} from "../src/config/apple-wallet.config";

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const parseArgs = (argv: string[]): Record<string, string> => {
  const args: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];

    if (!flag.startsWith("--")) continue;

    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      args[flag.slice(2)] = "true";
      continue;
    }

    args[flag.slice(2)] = next;
    i += 1;
  }

  return args;
};

const mustExist = (path: string, what: string): string => {
  if (!existsSync(path)) {
    fail(`${what} not found at ${path}`);
  }

  return path;
};

/**
 * A function declaration, not a const arrow, on purpose: only a declaration with an
 * explicit `never` return type lets TypeScript treat the call as terminating, which is
 * what makes the assignments after each guard provably definite.
 */
function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

/**
 * Splits the .p12 Keychain exports, because that is what someone actually has after
 * following Apple's instructions — a bundle, not two PEM files. Doing it here saves an
 * openssl incantation that is easy to get subtly wrong (notably -legacy, which newer
 * OpenSSL needs for Keychain's older encryption and whose absence produces a baffling
 * "unsupported" error).
 */
const splitP12 = (p12Path: string, passphrase: string): { cert: Buffer; key: Buffer } => {
  const run = (args: string[]): Buffer => {
    for (const extra of [[], ["-legacy"]]) {
      try {
        return execFileSync("openssl", [...args, ...extra], {
          input: passphrase,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch {
        // Fall through and retry with -legacy, which Keychain exports often need.
      }
    }

    return fail(
      "openssl could not read the .p12. The usual cause is a wrong export password — " +
        "that is the password typed when exporting from Keychain Access, which must also " +
        "be in APPLE_WALLET_SIGNER_KEY_PASSPHRASE."
    );
  };

  const base = ["pkcs12", "-in", p12Path, "-passin", "stdin"];

  return {
    cert: run([...base, "-clcerts", "-nokeys"]),
    // Re-encrypted under the same passphrase so the stored key is never left bare on
    // disk or in an environment variable.
    key: run([...base, "-nocerts", "-passout", `pass:${passphrase}`])
  };
};

const main = (): void => {
  const args = parseArgs(process.argv.slice(2));
  const passphrase = process.env.APPLE_WALLET_SIGNER_KEY_PASSPHRASE ?? "";

  if (!args.wwdr) {
    fail(
      "--wwdr is required. Download Apple's WWDR intermediate from " +
        "https://www.apple.com/certificateauthority/ — it must be the generation that " +
        "issued your signing certificate, which is G4 for anything issued recently."
    );
  }

  const wwdr = readFileSync(mustExist(args.wwdr, "WWDR certificate"));

  let signerCert: Buffer;
  let signerKey: Buffer;

  if (args.p12) {
    if (!passphrase) {
      fail(
        "APPLE_WALLET_SIGNER_KEY_PASSPHRASE is not set. A .p12 exported from Keychain " +
          "Access always has an export password; set it in the environment rather than " +
          "passing it as an argument, which ps would expose."
      );
    }

    ({ cert: signerCert, key: signerKey } = splitP12(
      mustExist(args.p12, ".p12 bundle"),
      passphrase
    ));
  } else if (args.cert && args.key) {
    signerCert = readFileSync(mustExist(args.cert, "signing certificate"));
    signerKey = readFileSync(mustExist(args.key, "signing key"));
  } else {
    fail("Pass either --p12, or both --cert and --key.");
  }

  const certificates: AppleWalletCertificates = {
    wwdr,
    signerCert,
    signerKey,
    signerKeyPassphrase: passphrase || undefined
  };

  // The real thing the server runs. Every failure mode is one it would hit at first
  // pass build; caught here so it reads as a report rather than a stack trace, with the
  // server's own wording preserved — the whole point is that the two cannot diverge.
  let identifiers: ReturnType<typeof preflightCertificates>;

  try {
    identifiers = preflightCertificates(certificates);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // The server's own reading, so the boot log and this report can never disagree about
  // the same certificate.
  const { validTo, daysRemaining } = certificateStatus(new Date(), {
    ...identifiers,
    organizationName: process.env.APPLE_WALLET_ORGANIZATION_NAME ?? "",
    certificates
  });
  const { passTypeIdentifier, teamIdentifier } = identifiers;

  console.log(`
  ✓ Signing material is valid.

    Pass type identifier   ${passTypeIdentifier}
    Team identifier        ${teamIdentifier}
    Expires                ${validTo.toISOString().slice(0, 10)}  (${plural(daysRemaining, "day")})

    Checked: certificate and key are a pair, WWDR issued the certificate,
    the passphrase decrypts the key, and the certificate is in date.
`);

  if (daysRemaining < RENEWAL_WARNING_DAYS) {
    console.warn(
      `  ! Expires in ${plural(daysRemaining, "day")}. Renew now — an expired certificate stops every\n` +
        `    pass installing and every update being accepted, with no error anywhere\n` +
        `    except on the device.\n`
    );
  }

  console.log(`  Next: set these on Railway without them touching your shell history.

    railway variable set --service voone-backend --stdin APPLE_WALLET_SIGNER_CERT_BASE64 \\
      < <(base64 -i <signerCert.pem>)

    ...and the same for APPLE_WALLET_SIGNER_KEY_BASE64, APPLE_WALLET_WWDR_CERT_BASE64,
    APPLE_WALLET_SIGNER_KEY_PASSPHRASE and APPLE_WALLET_ORGANIZATION_NAME.

    The pass type and team identifiers are NOT set: the server reads them off the
    certificate, so they cannot drift out of step with it.
`);
};

main();
