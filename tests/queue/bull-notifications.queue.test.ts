import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hand-written classes rather than vi.fn(): this suite runs with restoreMocks, which would
 * reset a vi.fn() between cases and hide the recorded calls.
 */
const fake = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  processor: null as ((job: unknown) => Promise<void>) | null,
  constructed: [] as Array<{ name: string; opts: Record<string, unknown> }>
}));

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(name: string, opts: Record<string, unknown>) {
      fake.constructed.push({ name, opts });
    }

    async add() {}

    async close() {}
  },
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<void>) {
      fake.processor = processor;
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      fake.handlers.set(event, handler);
      return this;
    }
  }
}));

import { createNotificationWorker } from "../../src/infrastructure/queue/bull-notifications.queue";
import type { NotificationService } from "../../src/modules/notifications/notification.service";

const serviceSpy = () => {
  const calls: Array<{ method: string; id: string }> = [];
  const service = {
    failExhaustedDelivery: async (id: string) => {
      calls.push({ method: "failExhaustedDelivery", id });
    },
    failExhaustedNotification: async (id: string) => {
      calls.push({ method: "failExhaustedNotification", id });
    },
    processDelivery: async () => {}
  } as unknown as NotificationService;

  return { service, calls };
};

const failedJob = (
  data: unknown,
  attemptsMade: number,
  attempts: number | null = 5
): Record<string, unknown> => ({
  id: "job-1",
  data,
  attemptsMade,
  opts: attempts === null ? {} : { attempts }
});

const emitFailed = async (job: unknown, error: Error = new Error("boom")) => {
  const handler = fake.handlers.get("failed");

  if (!handler) throw new Error("no failed handler registered");

  handler(job, error);
  // The handler fires the service call without awaiting it.
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("createNotificationWorker failed event", () => {
  beforeEach(() => {
    fake.handlers.clear();
    fake.processor = null;
    fake.constructed.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("does not touch a delivery whose job will be retried", async () => {
    const { service, calls } = serviceSpy();
    createNotificationWorker("redis://localhost:6379", service);

    await emitFailed(failedJob({ kind: "delivery", deliveryId: "d-1" }, 1));
    await emitFailed(failedJob({ kind: "delivery", deliveryId: "d-1" }, 4));

    expect(calls).toEqual([]);
  });

  it("fails the delivery once, by id, when its last attempt has been used", async () => {
    const { service, calls } = serviceSpy();
    createNotificationWorker("redis://localhost:6379", service);

    await emitFailed(failedJob({ kind: "delivery", deliveryId: "d-1" }, 5));

    expect(calls).toEqual([{ method: "failExhaustedDelivery", id: "d-1" }]);
  });

  it("treats a job with no attempts option as a single attempt", async () => {
    const { service, calls } = serviceSpy();
    createNotificationWorker("redis://localhost:6379", service);

    await emitFailed(failedJob({ kind: "delivery", deliveryId: "d-2" }, 1, null));

    expect(calls).toEqual([{ method: "failExhaustedDelivery", id: "d-2" }]);
  });

  it("treats an UnrecoverableError as final even with attempts left", async () => {
    const { service, calls } = serviceSpy();
    createNotificationWorker("redis://localhost:6379", service);
    const unrecoverable = new Error("never retry");
    unrecoverable.name = "UnrecoverableError";

    await emitFailed(failedJob({ kind: "delivery", deliveryId: "d-3" }, 1), unrecoverable);

    expect(calls).toEqual([{ method: "failExhaustedDelivery", id: "d-3" }]);
  });

  it("treats a stalled job as final: BullMQ fails it with an UnrecoverableError while attempts remain", async () => {
    const { service, calls } = serviceSpy();
    createNotificationWorker("redis://localhost:6379", service);
    // What BullMQ 6 emits once a job has stalled more than maxStalledCount times: the job
    // is present, attemptsMade is still below attempts, and the error is an UnrecoverableError.
    const stalled = new Error("job stalled more than allowable limit");
    stalled.name = "UnrecoverableError";

    await emitFailed(failedJob({ kind: "delivery", deliveryId: "d-4" }, 0), stalled);
    await emitFailed(failedJob({ kind: "notification", notificationId: "n-4" }, 0), stalled);

    expect(calls).toEqual([
      { method: "failExhaustedDelivery", id: "d-4" },
      { method: "failExhaustedNotification", id: "n-4" }
    ]);
  });

  it("does not close a job that failed with an ordinary error while attempts remain", async () => {
    const { service, calls } = serviceSpy();
    createNotificationWorker("redis://localhost:6379", service);

    await emitFailed(
      failedJob({ kind: "delivery", deliveryId: "d-5" }, 0),
      new Error("job stalled more than allowable limit")
    );

    expect(calls).toEqual([]);
  });

  it("fails a notification, not a delivery, when a notification job is exhausted", async () => {
    const { service, calls } = serviceSpy();
    createNotificationWorker("redis://localhost:6379", service);

    await emitFailed(failedJob({ kind: "notification", notificationId: "n-1" }, 2));
    await emitFailed(failedJob({ kind: "notification", notificationId: "n-1" }, 5));

    expect(calls).toEqual([{ method: "failExhaustedNotification", id: "n-1" }]);
  });

  it("does nothing for a points-credit job, exhausted or not", async () => {
    const { service, calls } = serviceSpy();
    createNotificationWorker("redis://localhost:6379", service);

    await emitFailed(failedJob({ kind: "points-credit", memberId: "m-1" }, 5));

    expect(calls).toEqual([]);
  });

  it("ignores a failed event that carries no job (BullMQ types the job as optional)", async () => {
    const { service, calls } = serviceSpy();
    createNotificationWorker("redis://localhost:6379", service);

    await emitFailed(undefined);

    expect(calls).toEqual([]);
  });

  it("keeps logging the failure", async () => {
    const { service } = serviceSpy();
    createNotificationWorker("redis://localhost:6379", service);

    await emitFailed(failedJob({ kind: "delivery", deliveryId: "d-1" }, 1));

    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("does not let a rejecting service call escape the event handler", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const service = {
      failExhaustedDelivery: async () => {
        throw new Error("db down");
      }
    } as unknown as NotificationService;
    createNotificationWorker("redis://localhost:6379", service);

    await emitFailed(failedJob({ kind: "delivery", deliveryId: "d-1" }, 5));
    process.off("unhandledRejection", unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });
});
