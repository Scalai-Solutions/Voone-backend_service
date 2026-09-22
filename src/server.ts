import { buildApp } from "./app";
import { certificateStatus, isAppleWalletConfigured } from "./config/apple-wallet.config";
import { config } from "./config/env";
import { prisma } from "./infrastructure/database/prisma-client";
import { startInProcessWalletWorker } from "./wallet/wallet.composition";

const app = buildApp();

// Signing material is a feature precondition, not a boot one: the service runs fine
// without it and only pass generation fails, so this warns rather than exits.
if (!isAppleWalletConfigured()) {
  console.warn("Apple Wallet signing is not configured; pass generation is disabled.");
} else {
  // Reported on every boot, not just when it is nearly due. An expired Pass Type ID
  // certificate fails silently and totally — no pass installs, no update is accepted,
  // and the only symptom is members noticing their points stopped moving. A line in the
  // startup log is the cheapest place for that date to be visible.
  const certificate = certificateStatus();

  console.log(
    `[apple-wallet] ${certificate.passTypeIdentifier} · certificate valid until ` +
      `${certificate.validTo.toISOString().slice(0, 10)} (${certificate.daysRemaining} days)`
  );

  if (certificate.expiresSoon) {
    console.warn(
      `[apple-wallet] RENEW NOW: the signing certificate expires in ` +
        `${certificate.daysRemaining} days. Once it lapses no pass installs and no ` +
        `update is accepted, with no error anywhere except on the device.`
    );
  }
}

// Consumes the wallet sync queue in this process unless a dedicated worker service has
// been given the job. A durable queue nobody consumes is worse than no queue: jobs pile
// up, every card goes stale, and nothing looks broken.
const walletWorker = startInProcessWalletWorker(prisma);

if (walletWorker) {
  console.log("[wallet] consuming the sync queue in this process");
}

const server = app.listen(config.PORT, () => {
  console.log(`Voone backend listening at http://localhost:${config.PORT}`);
});

// Jobs already running are finished rather than killed: a sync cut off midway leaves a
// WalletObject row PENDING with no retry scheduled.
const shutdown = async (signal: string): Promise<void> => {
  console.log(`${signal} received, shutting down`);

  server.close();
  await walletWorker?.close();
  await prisma.$disconnect();

  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
