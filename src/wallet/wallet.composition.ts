import type { PrismaClient } from "@prisma/client";

import { config } from "../config/env";
import type { Worker } from "bullmq";

import {
  BullWalletSyncQueue,
  createWalletSyncWorker,
  type WalletSyncJob
} from "../infrastructure/queue/bull-wallet-sync.queue";
import { NoopRefreshChannel } from "./engine/pass-refresh-channel.interface";
import { WalletProviderRegistry } from "./engine/wallet-provider.registry";
import { InlineWalletSyncQueue, WalletSyncQueue } from "./engine/wallet-sync.queue";
import { WalletSyncService } from "./engine/wallet-sync.service";
import { PrismaLoyaltyCardAssembler } from "./prisma-loyalty-card.assembler";
import { PrismaPassDeviceRepository } from "./prisma-pass-device.repository";
import { PrismaWalletSyncRepository } from "./prisma-wallet-sync.repository";
import { createAppleWalletProvider } from "./providers/apple/apple-wallet.provider";
import { createGoogleWalletProvider } from "./providers/google";

/**
 * Where the wallet subsystem is assembled.
 *
 * The one place that knows which concrete classes exist. Everything else depends on the
 * ports, which is what has let each piece be built and tested on its own — and what lets
 * the Google adapter be added here later without touching anything that calls a wallet.
 */
export const buildWalletRegistry = (prisma: PrismaClient): WalletProviderRegistry => {
  const registry = new WalletProviderRegistry();
  const syncRepo = new PrismaWalletSyncRepository(prisma);

  // Registers only if signing material is present. That is the whole mechanism: with no
  // certificate the Apple adapter is deployed, constructed, and never registered — so
  // nothing resolves it and no business code carries an `if apple`.
  if (config.APPLE_PASS_WEB_SERVICE_URL) {
    const registered = registry.register(
      createAppleWalletProvider(
        syncRepo,
        // Real pushes land with the APNs client. Until then a sync republishes the pass
        // and the device collects it on its own schedule.
        new NoopRefreshChannel(),
        new PrismaPassDeviceRepository(prisma),
        config.APPLE_PASS_WEB_SERVICE_URL
      )
    );

    if (!registered) {
      // Worth saying out loud: "deployed but unconfigured" and "not deployed" look
      // identical from the outside, and the difference is hours when a clinic reports
      // that half its members got no card.
      console.warn("[wallet] Apple provider not registered: no signing certificate is configured.");
    }
  }

  const googleRegistered = registry.register(createGoogleWalletProvider(syncRepo));

  if (!googleRegistered) {
    console.warn("[wallet] Google provider not registered: service account is not configured.");
  }

  return registry;
};

/**
 * Whether the wallet subsystem has what it needs to run at all.
 *
 * Checked before construction rather than discovered inside it, so a half-configured
 * deployment degrades instead of failing to boot. Membership sign-up does not need
 * wallets, and taking the whole API down because a card cannot be assembled would turn a
 * feature gap into an outage.
 */
export const isWalletSyncConfigured = (): boolean => Boolean(config.CARD_REDEMPTION_SECRET);

export const buildWalletSyncService = (prisma: PrismaClient): WalletSyncService => {
  if (!config.CARD_REDEMPTION_SECRET) {
    // Reaching here means a caller skipped isWalletSyncConfigured(), which is a
    // programming error rather than a configuration one — hence a throw.
    throw new Error(
      "CARD_REDEMPTION_SECRET is required to assemble loyalty cards. Call " +
        "isWalletSyncConfigured() before building the wallet subsystem."
    );
  }

  return new WalletSyncService(
    buildWalletRegistry(prisma),
    new PrismaWalletSyncRepository(prisma),
    new PrismaLoyaltyCardAssembler(prisma, config.CARD_REDEMPTION_SECRET)
  );
};

/**
 * The queue the API enqueues onto.
 *
 * Inline by default, deliberately. The call sites are identical either way, so moving to
 * the durable queue is a configuration change rather than a code change — and a
 * deployment with no Redis still works, just without retries.
 */
export const buildWalletSyncQueue = (prisma: PrismaClient): WalletSyncQueue | null => {
  if (config.WALLET_SYNC_MODE === "queue") {
    return new BullWalletSyncQueue(config.REDIS_URL);
  }

  // Null rather than a throw, for the same reason as above: a caller that cannot sync
  // wallets should skip the enqueue, not fail the request that triggered it.
  return isWalletSyncConfigured()
    ? new InlineWalletSyncQueue(buildWalletSyncService(prisma))
    : null;
};

/**
 * A queue consumer inside the API process.
 *
 * Returns null when there is nothing to consume — inline mode, or a deployment that has
 * handed consumption to a dedicated worker service.
 *
 * Concurrency is deliberately low. Signing a .pkpass is CPU-bound and this shares an
 * event loop with request handling, so the ceiling exists to stop a backlog of syncs
 * slowing the scan at reception — which is the exact coupling the queue was added to
 * prevent, and would be embarrassing to reintroduce here.
 */
export const startInProcessWalletWorker = (prisma: PrismaClient): Worker<WalletSyncJob> | null => {
  if (config.WALLET_SYNC_MODE !== "queue" || !config.WALLET_WORKER_IN_PROCESS) {
    return null;
  }

  // The trap this exists to disarm: turning WALLET_SYNC_MODE on without also setting
  // CARD_REDEMPTION_SECRET used to throw here, at import, taking the entire API down —
  // sign-up included, which needs no wallet at all. A config flip must not be able to
  // cause an outage, so this warns and leaves the queue unconsumed instead.
  if (!isWalletSyncConfigured()) {
    console.warn(
      "[wallet] WALLET_SYNC_MODE is 'queue' but CARD_REDEMPTION_SECRET is unset, so " +
        "cards cannot be assembled. Not consuming the queue — jobs will accumulate " +
        "until it is set."
    );

    return null;
  }

  const worker = createWalletSyncWorker(config.REDIS_URL, buildWalletSyncService(prisma), 2);

  worker.on("failed", (job, error) => {
    console.error(`[wallet] job ${job?.id ?? "?"} failed:`, error.message);
  });

  worker.on("error", (error) => {
    console.error("[wallet] worker error:", error.message);
  });

  return worker;
};
