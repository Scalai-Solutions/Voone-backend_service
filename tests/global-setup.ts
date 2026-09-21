import { rmSync } from "node:fs";

import {
  TEST_CERT_DIR,
  TEST_KEY_PASSPHRASE,
  assertOpensslAvailable,
  generateTestChain,
  toBase64
} from "./helpers/test-certificates";

/**
 * Generates the throwaway signing chain once per run and publishes it the same way
 * production receives it — base64 PEM in environment variables — so the tests exercise
 * the real decoding path rather than bypassing it.
 */
export default function setup(): () => void {
  assertOpensslAvailable();

  const paths = generateTestChain();

  process.env.APPLE_WALLET_ORGANIZATION_NAME = "Voone Test";
  process.env.APPLE_WALLET_SIGNER_CERT_BASE64 = toBase64(paths.signerCertPath);
  process.env.APPLE_WALLET_SIGNER_KEY_BASE64 = toBase64(paths.signerKeyPath);
  process.env.APPLE_WALLET_WWDR_CERT_BASE64 = toBase64(paths.caCertPath);
  process.env.APPLE_WALLET_SIGNER_KEY_PASSPHRASE = TEST_KEY_PASSPHRASE;

  return () => {
    rmSync(TEST_CERT_DIR, { recursive: true, force: true });
  };
}
