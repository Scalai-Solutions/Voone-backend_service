import { buildApp } from "./app";
import { isAppleWalletConfigured } from "./config/apple-wallet.config";
import { config } from "./config/env";
import { prisma } from "./infrastructure/database/prisma-client";
import { startInProcessWalletWorker } from "./wallet/wallet.composition";

const app = buildApp();

// Signing material is a feature precondition, not a boot one: the service runs fine
// without it and only pass generation fails, so this warns rather than exits.
if (!isAppleWalletConfigured()) {
  console.warn("Apple Wallet signing is not configured; pass generation is disabled.");
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
