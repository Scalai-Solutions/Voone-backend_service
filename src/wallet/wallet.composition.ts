import type { PrismaClient } from "@prisma/client";

import { config } from "../config/env";
import { BullWalletSyncQueue } from "../infrastructure/queue/bull-wallet-sync.queue";
import { NoopRefreshChannel } from "./engine/pass-refresh-channel.interface";
import { WalletProviderRegistry } from "./engine/wallet-provider.registry";
import { InlineWalletSyncQueue, WalletSyncQueue } from "./engine/wallet-sync.queue";
import { WalletSyncService } from "./engine/wallet-sync.service";
import { PrismaLoyaltyCardAssembler } from "./prisma-loyalty-card.assembler";
import { PrismaPassDeviceRepository } from "./prisma-pass-device.repository";
import { PrismaWalletSyncRepository } from "./prisma-wallet-sync.repository";
import { createAppleWalletProvider } from "./providers/apple/apple-wallet.provider";

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

  // The Google adapter is registered here too, once it exists.

  return registry;
};

export const buildWalletSyncService = (prisma: PrismaClient): WalletSyncService => {
  if (!config.CARD_REDEMPTION_SECRET) {
    throw new Error(
      "CARD_REDEMPTION_SECRET is required to assemble loyalty cards. Set it, or leave " +
        "the wallet subsystem unconfigured."
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
export const buildWalletSyncQueue = (prisma: PrismaClient): WalletSyncQueue =>
  config.WALLET_SYNC_MODE === "queue"
    ? new BullWalletSyncQueue(config.REDIS_URL)
    : new InlineWalletSyncQueue(buildWalletSyncService(prisma));
