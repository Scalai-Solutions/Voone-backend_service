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
    const jobId = `delivery-${deliveryId}`;

    // BullMQ ignores an add whose id exists in ANY state, and this queue keeps finished
    // jobs (an hour) and failed ones (seven days). Callers only enqueue a delivery that is
    // still QUEUED, so a FINISHED job under this id means the delivery was never settled:
    // typically a transient wallet outage that spent all five attempts. Left in place it
    // would swallow the re-enqueue by the birthday and bono crons and by the broadcast
    // fan-out, stranding the delivery. A waiting, delayed or active job is kept, which is
    // the deduplication this id exists for.
    await this.clearFinishedJob(jobId);
    await this.queue.add("delivery", { kind: "delivery", deliveryId }, { jobId, delay: delayMs });
  }

  async enqueuePointsCredit(job: PointsCreditNotificationJob): Promise<void> {
    await this.queue.add("points-credit", { kind: "points-credit", ...job });
  }

  private async clearFinishedJob(jobId: string): Promise<void> {
    const existing = await this.queue.getJob(jobId);

    if (!existing) return;

    const state = await existing.getState();

    if (state !== "failed" && state !== "completed") return;

    try {
      await existing.remove();
    } catch {
      // Gone already (retention removed it) or picked up in between: either way the add
      // below does the right thing, so this is not worth failing the enqueue for.
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

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
  });
  worker.on("error", createRepeatingErrorLogger("[notifications] worker error:"));

  return worker;
};
