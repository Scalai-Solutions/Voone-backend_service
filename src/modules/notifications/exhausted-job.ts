import type { NotificationService } from "./notification.service";

/** The part of a queued notification job that decides how an exhausted one is closed. */
export type ClosableJob =
  | { kind: "notification"; notificationId: string }
  | { kind: "delivery"; deliveryId: string }
  | { kind: "points-credit" };

/**
 * True when the queue will not run this job again: its last attempt is used (attemptsMade
 * already counts the failure being judged), or the error is an UnrecoverableError.
 *
 * The UnrecoverableError clause is ESSENTIAL, do not remove it: a job that stalled more
 * than maxStalledCount times is failed by BullMQ with an UnrecoverableError ("job stalled
 * more than allowable limit") while attemptsMade is still below attempts, and the event
 * does carry the job. Without the clause such a delivery would stay QUEUED forever.
 */
export const isFinalFailure = (attemptsMade: number, attempts: number, error: Error): boolean =>
  error.name === "UnrecoverableError" || attemptsMade >= attempts;

/**
 * Closes a job that is finished for good: a delivery becomes FAILED and a broadcast is
 * finalised. Terminal on purpose, never a re-enqueue: a Google message may have been written
 * before the job failed, and running it again could post a duplicate.
 *
 * Null for a job kind with nothing to close (points-credit). The service methods are written
 * never to reject; callers still catch, so no unhandled rejection can come out of this.
 */
export const closeExhaustedJob = (
  service: Pick<NotificationService, "failExhaustedDelivery" | "failExhaustedNotification">,
  job: ClosableJob
): Promise<void> | null =>
  job.kind === "delivery"
    ? service.failExhaustedDelivery(job.deliveryId)
    : job.kind === "notification"
      ? service.failExhaustedNotification(job.notificationId)
      : null;
