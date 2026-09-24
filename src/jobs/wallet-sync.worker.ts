import { config } from "../config/env";
import { createRepeatingErrorLogger } from "../common/logger/repeating-error-logger";
import { prisma } from "../infrastructure/database/prisma-client";
import { createWalletSyncWorker } from "../infrastructure/queue/bull-wallet-sync.queue";
import { buildWalletSyncService } from "../wallet/wallet.composition";

/**
 * The wallet sync worker, as its own process.
 *
 * Run with `npm run worker`. Deliberately not started inside the API: a burst of pass
 * signings would compete with request handling for the same event loop, and reception
 * scanning a card is the thing that must stay fast.
 *
 * Exits rather than idling when the queue is not configured, so a misconfigured
 * deployment fails visibly at start instead of looking healthy and processing nothing.
 */
const main = async (): Promise<void> => {
  if (config.WALLET_SYNC_MODE !== "queue") {
    console.error(
      "WALLET_SYNC_MODE is not 'queue', so there is no queue to consume. " +
        "The API is running syncs inline; this worker has nothing to do."
    );
    process.exit(1);
  }

  if (config.WALLET_WORKER_IN_PROCESS) {
    // Not fatal — two consumers is safe, BullMQ hands each job to one of them. But it is
    // almost always a misconfiguration, and silently doubling capacity is the kind of
    // thing that is discovered months later while debugging something else.
    console.warn(
      "WALLET_WORKER_IN_PROCESS is true, so the API is consuming the queue as well. " +
        "Set it to false on the API now that a dedicated worker is running."
    );
  }

  const worker = createWalletSyncWorker(config.REDIS_URL, buildWalletSyncService(prisma));

  worker.on("failed", (job, error) => {
    console.error(`[wallet] job ${job?.id ?? "?"} failed:`, error.message);
  });

  // Connection-level trouble. BullMQ reconnects on its own; logging it is what makes a
  // flapping Redis visible rather than mysterious — but throttled, because "reconnects on
  // its own" means an unresolvable fault repeats without limit.
  worker.on("error", createRepeatingErrorLogger("[wallet] worker error:"));

  console.log(`[wallet] sync worker listening on ${redactedRedisHost(config.REDIS_URL)}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[wallet] ${signal} received, finishing in-flight jobs`);

    // Waits for jobs already running rather than killing them mid-sync, which would
    // leave a WalletObject row PENDING with no retry scheduled.
    await worker.close();
    await prisma.$disconnect();

    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
};

/** Host only: a Redis URL carries a password. */
const redactedRedisHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "the configured Redis";
  }
};

void main();
