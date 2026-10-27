import { Queue, Worker, type Job } from "bullmq";

import { createRepeatingErrorLogger } from "../../common/logger/repeating-error-logger";
import type {
  NotificationJobQueue,
  NotificationService,
  PointsCreditNotificationJob
} from "../../modules/notifications/notification.service";
import { redisConnection } from "./bull-wallet-sync.queue";

export const NOTIFICATIONS_QUEUE = "wallet-notifications";

type NotificationQueueJob =
  | { kind: "notification"; notificationId: string }
  | { kind: "delivery"; deliveryId: string }
  | ({ kind: "points-credit" } & PointsCreditNotificationJob);

export class BullNotificationQueue implements NotificationJobQueue {
  private readonly queue: Queue<NotificationQueueJob>;

  constructor(redisUrl: string) {
    this.queue = new Queue<NotificationQueueJob>(NOTIFICATIONS_QUEUE, {
      connection: redisConnection(redisUrl),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 7 * 24 * 3_600 }
      }
    });
  }

  async enqueueNotification(notificationId: string, delayMs = 0): Promise<void> {
    await this.queue.add(
      "notification",
      { kind: "notification", notificationId },
      { jobId: `notification-${notificationId}`, delay: delayMs }
    );
  }

  async enqueueDelivery(deliveryId: string, delayMs = 0): Promise<void> {
    await this.queue.add(
      "delivery",
      { kind: "delivery", deliveryId },
      { jobId: `delivery-${deliveryId}`, delay: delayMs }
    );
  }

  async enqueuePointsCredit(job: PointsCreditNotificationJob): Promise<void> {
    await this.queue.add("points-credit", { kind: "points-credit", ...job });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * True when BullMQ will not run this job again: its last attempt is used (attemptsMade
 * already counts the failure that raised the event), or the error opted out of retries.
 */
const isFinalFailure = (job: Job<NotificationQueueJob>, error: Error): boolean =>
  error.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts ?? 1);

export const createNotificationWorker = (
  redisUrl: string,
  service: NotificationService,
  concurrency = 5
): Worker<NotificationQueueJob> => {
  const worker = new Worker<NotificationQueueJob>(
    NOTIFICATIONS_QUEUE,
    async (job: Job<NotificationQueueJob>) => {
      if (job.data.kind === "notification") {
        await service.processNotification(job.data.notificationId);
        return;
      }

      if (job.data.kind === "delivery") {
        await service.processDelivery(job.data.deliveryId);
        return;
      }

      await service.processPointsCredit(job.data);
    },
    { connection: redisConnection(redisUrl), concurrency }
  );

  worker.on("failed", (job, error) => {
    console.error(`[notifications] job ${job?.id ?? "?"} failed:`, error.message);

    if (!job || !isFinalFailure(job, error)) return;

    // Terminal on purpose, never a re-enqueue: a Google message may have been written before
    // the job failed, and running it again could post a duplicate. The service methods are
    // written never to reject; the catch is a second line so this handler cannot raise an
    // unhandled rejection either way.
    const close =
      job.data.kind === "delivery"
        ? service.failExhaustedDelivery(job.data.deliveryId)
        : job.data.kind === "notification"
          ? service.failExhaustedNotification(job.data.notificationId)
          : null;

    void close?.catch((closeError: unknown) => {
      console.error("[notifications] could not close an exhausted job", {
        jobId: job.id,
        error: closeError instanceof Error ? closeError.name : "UNKNOWN"
      });
    });
  });
  worker.on("error", createRepeatingErrorLogger("[notifications] worker error:"));

  return worker;
};
