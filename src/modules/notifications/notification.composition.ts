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
import { buildWalletRegistry } from "../../wallet/wallet.composition";
import { InMemoryNotificationQuotaRedis, NotificationQuotaService } from "./quota.service";
import {
  NotificationJobQueue,
  NotificationService,
  PointsCreditNotificationJob
} from "./notification.service";

class InlineNotificationQueue implements NotificationJobQueue {
  private readonly attempts = 5;

  private service: NotificationService | null = null;

  bind(service: NotificationService): void {
    this.service = service;
  }

  async enqueueNotification(notificationId: string, delayMs = 0): Promise<void> {
    this.runLater(delayMs, `notification-${notificationId}`, () =>
      this.requiredService().processNotification(notificationId)
    );
  }

  async enqueueDelivery(deliveryId: string, delayMs = 0): Promise<void> {
    this.runLater(delayMs, `delivery-${deliveryId}`, () =>
      this.requiredService().processDelivery(deliveryId)
    );
  }

  async enqueuePointsCredit(job: PointsCreditNotificationJob): Promise<void> {
    this.runLater(0, `points-credit-${job.memberId}`, () =>
      this.requiredService().processPointsCredit(job)
    );
  }

  private runLater(delayMs: number, label: string, run: () => Promise<void>): void {
    if (delayMs <= 0) {
      void this.runWithRetry(label, run);
      return;
    }

    const timer = setTimeout(() => {
      void this.runWithRetry(label, run);
    }, delayMs);

    timer.unref?.();
  }

  private async runWithRetry(label: string, run: () => Promise<void>): Promise<void> {
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        await run();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (attempt >= this.attempts) {
          console.error("[notifications] inline job failed", { label, attempt, error: message });
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

  private requiredService(): NotificationService {
    if (!this.service) {
      throw new Error("Inline notification queue was used before it was bound to a service");
    }

    return this.service;
  }
}

export const buildNotificationService = (prisma: PrismaClient): NotificationService => {
  if (config.WALLET_SYNC_MODE !== "queue") {
    const queue = new InlineNotificationQueue();
    const service = new NotificationService(
      prisma,
      new WalletPassEngine(buildWalletRegistry(prisma)),
      new NotificationQuotaService(new InMemoryNotificationQuotaRedis()),
      queue
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
    new BullNotificationQueue(config.REDIS_URL)
  );
};

export const startInProcessNotificationWorker = (prisma: PrismaClient): Worker | null => {
  if (config.WALLET_SYNC_MODE !== "queue" || !config.WALLET_WORKER_IN_PROCESS) {
    return null;
  }

  const worker = createNotificationWorker(config.REDIS_URL, buildNotificationService(prisma), 3);

  worker.on("error", createRepeatingErrorLogger("[notifications] worker error:"));

  return worker;
};
