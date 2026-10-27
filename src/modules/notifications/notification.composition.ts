import type { Worker } from "bullmq";
import Redis from "ioredis";
import type { PrismaClient } from "@prisma/client";

import { createRepeatingErrorLogger } from "../../common/logger/repeating-error-logger";
import { config } from "../../config/env";
import {
  BullNotificationQueue,
  createNotificationWorker
} from "../../infrastructure/queue/bull-notifications.queue";
import { WalletPassEngine } from "../../wallet/engine/wallet-pass.engine";
import { WalletSyncAppleCardRefresher } from "../../wallet/apple-card-refresher";
import {
  buildWalletRegistry,
  buildWalletSyncService,
  isWalletSyncConfigured
} from "../../wallet/wallet.composition";
import { closeExhaustedJob, isFinalFailure, type ClosableJob } from "./exhausted-job";
import { InMemoryNotificationQuotaRedis, NotificationQuotaService } from "./quota.service";
import {
  AppleCardRefresher,
  NotificationJobQueue,
  NotificationService,
  PointsCreditNotificationJob
} from "./notification.service";

export class InlineNotificationQueue implements NotificationJobQueue {
  private readonly attempts = 5;

  private service: NotificationService | null = null;

  bind(service: NotificationService): void {
    this.service = service;
  }

  async enqueueNotification(notificationId: string, delayMs = 0): Promise<void> {
    this.runLater(
      delayMs,
      `notification-${notificationId}`,
      () => this.requiredService().processNotification(notificationId),
      { kind: "notification", notificationId }
    );
  }

  async enqueueDelivery(deliveryId: string, delayMs = 0): Promise<void> {
    this.runLater(
      delayMs,
      `delivery-${deliveryId}`,
      () => this.requiredService().processDelivery(deliveryId),
      { kind: "delivery", deliveryId }
    );
  }

  async enqueuePointsCredit(job: PointsCreditNotificationJob): Promise<void> {
    this.runLater(
      0,
      `points-credit-${job.memberId}`,
      () => this.requiredService().processPointsCredit(job),
      { kind: "points-credit" }
    );
  }

  private runLater(
    delayMs: number,
    label: string,
    run: () => Promise<void>,
    job: ClosableJob
  ): void {
    if (delayMs <= 0) {
      void this.runWithRetry(label, run, job);
      return;
    }

    const timer = setTimeout(() => {
      void this.runWithRetry(label, run, job);
    }, delayMs);

    timer.unref?.();
  }

  private async runWithRetry(
    label: string,
    run: () => Promise<void>,
    job: ClosableJob
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        await run();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (
          isFinalFailure(
            attempt,
            this.attempts,
            error instanceof Error ? error : new Error(message)
          )
        ) {
          console.error("[notifications] inline job failed", { label, attempt, error: message });
          await this.closeExhausted(label, job);
          return;
        }

        const delayMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1));

        console.warn("[notifications] inline job failed; retrying", {
          label,
          attempt,
          nextAttemptInMs: delayMs,
          error: message
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /** The inline counterpart of the BullMQ `failed` handler: same close, never throws. */
  private async closeExhausted(label: string, job: ClosableJob): Promise<void> {
    if (job.kind === "points-credit") return;

    try {
      await closeExhaustedJob(this.requiredService(), job);
    } catch (error) {
      console.error("[notifications] could not close an exhausted inline job", {
        label,
        error: error instanceof Error ? error.name : "UNKNOWN"
      });
    }
  }

  private requiredService(): NotificationService {
    if (!this.service) {
      throw new Error("Inline notification queue was used before it was bound to a service");
    }

    return this.service;
  }
}

/**
 * Refreshes an Apple card in-process, inside the delivery job that asked for it: each
 * delivery is its own job, so a broadcast is paced by the notification queue's concurrency.
 *
 * Null without CARD_REDEMPTION_SECRET: no card can be assembled, and the delivery is then
 * marked FAILED rather than the service refusing to start.
 */
const buildAppleCardRefresher = (prisma: PrismaClient): AppleCardRefresher | null =>
  isWalletSyncConfigured()
    ? new WalletSyncAppleCardRefresher(buildWalletSyncService(prisma))
    : null;

export const buildNotificationService = (prisma: PrismaClient): NotificationService => {
  if (config.WALLET_SYNC_MODE !== "queue") {
    const queue = new InlineNotificationQueue();
    const service = new NotificationService(
      prisma,
      new WalletPassEngine(buildWalletRegistry(prisma)),
      new NotificationQuotaService(new InMemoryNotificationQuotaRedis()),
      queue,
      buildAppleCardRefresher(prisma)
    );

    queue.bind(service);

    return service;
  }

  const quotaRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  quotaRedis.on("error", createRepeatingErrorLogger("[notifications] quota redis error:"));

  return new NotificationService(
    prisma,
    new WalletPassEngine(buildWalletRegistry(prisma)),
    new NotificationQuotaService(quotaRedis),
    new BullNotificationQueue(config.REDIS_URL),
    buildAppleCardRefresher(prisma)
  );
};

export const startInProcessNotificationWorker = (
  prisma: PrismaClient,
  service = buildNotificationService(prisma)
): Worker | null => {
  if (config.WALLET_SYNC_MODE !== "queue" || !config.WALLET_WORKER_IN_PROCESS) {
    return null;
  }

  const worker = createNotificationWorker(config.REDIS_URL, service, 3);

  worker.on("error", createRepeatingErrorLogger("[notifications] worker error:"));

  return worker;
};
