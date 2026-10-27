import {
  NotificationDeliveryStatus,
  NotificationStatus,
  WalletProviderType,
  WalletSyncStatus
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WalletNotificationTransientError } from "../../src/common/errors/wallet.errors";
import { InlineNotificationQueue } from "../../src/modules/notifications/notification.composition";
import { NotificationService } from "../../src/modules/notifications/notification.service";

/** More than the whole backoff (2 + 4 + 8 + 16 seconds) of five attempts. */
const WHOLE_BACKOFF_MS = 60_000;

const spyService = (processors: {
  delivery?: () => Promise<void>;
  notification?: () => Promise<void>;
  pointsCredit?: () => Promise<void>;
  closeDelivery?: () => Promise<void>;
}) => {
  const calls: string[] = [];
  const service = {
    processDelivery: async (id: string) => {
      calls.push(`processDelivery:${id}`);
      await processors.delivery?.();
    },
    processNotification: async (id: string) => {
      calls.push(`processNotification:${id}`);
      await processors.notification?.();
    },
    processPointsCredit: async () => {
      calls.push("processPointsCredit");
      await processors.pointsCredit?.();
    },
    failExhaustedDelivery: async (id: string) => {
      calls.push(`failExhaustedDelivery:${id}`);
      await processors.closeDelivery?.();
    },
    failExhaustedNotification: async (id: string) => {
      calls.push(`failExhaustedNotification:${id}`);
    }
  } as unknown as NotificationService;
  const queue = new InlineNotificationQueue();

  queue.bind(service);

  return { queue, calls };
};

const count = (calls: string[], prefix: string) =>
  calls.filter((call) => call.startsWith(prefix)).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("InlineNotificationQueue exhausted jobs", () => {
  it("closes a delivery job once, after its fifth failed attempt", async () => {
    const { queue, calls } = spyService({
      delivery: async () => {
        throw new WalletNotificationTransientError("google down");
      }
    });

    await queue.enqueueDelivery("delivery-1");
    await vi.advanceTimersByTimeAsync(WHOLE_BACKOFF_MS);

    expect(count(calls, "processDelivery")).toBe(5);
    expect(calls.filter((call) => call.startsWith("failExhausted"))).toEqual([
      "failExhaustedDelivery:delivery-1"
    ]);
    expect(calls.at(-1)).toBe("failExhaustedDelivery:delivery-1");
  });

  it("closes a notification job through failExhaustedNotification", async () => {
    const { queue, calls } = spyService({
      notification: async () => {
        throw new Error("boom");
      }
    });

    await queue.enqueueNotification("notification-1");
    await vi.advanceTimersByTimeAsync(WHOLE_BACKOFF_MS);

    expect(count(calls, "processNotification")).toBe(5);
    expect(calls.filter((call) => call.startsWith("failExhausted"))).toEqual([
      "failExhaustedNotification:notification-1"
    ]);
  });

  it("does not close a job that succeeds on attempt 3", async () => {
    let attempts = 0;
    const { queue, calls } = spyService({
      delivery: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("transient");
      }
    });

    await queue.enqueueDelivery("delivery-1");
    await vi.advanceTimersByTimeAsync(WHOLE_BACKOFF_MS);

    expect(count(calls, "processDelivery")).toBe(3);
    expect(count(calls, "failExhausted")).toBe(0);
  });

  it("stops retrying on an UnrecoverableError and closes the job at once", async () => {
    const { queue, calls } = spyService({
      delivery: async () => {
        const error = new Error("stalled more than allowable limit");

        error.name = "UnrecoverableError";
        throw error;
      }
    });

    await queue.enqueueDelivery("delivery-1");
    await vi.advanceTimersByTimeAsync(WHOLE_BACKOFF_MS);

    expect(count(calls, "processDelivery")).toBe(1);
    expect(calls.filter((call) => call.startsWith("failExhausted"))).toEqual([
      "failExhaustedDelivery:delivery-1"
    ]);
  });

  it("does not close a job on a non-final failure", async () => {
    const { queue, calls } = spyService({
      delivery: async () => {
        throw new Error("transient");
      }
    });

    await queue.enqueueDelivery("delivery-1");
    // The first attempt and its backoff only: attempts 2 to 5 have not run yet.
    await vi.advanceTimersByTimeAsync(1_000);

    expect(count(calls, "processDelivery")).toBe(1);
    expect(count(calls, "failExhausted")).toBe(0);
  });

  it("stays a no-op for a points-credit job, even when it exhausts its attempts", async () => {
    const { queue, calls } = spyService({
      pointsCredit: async () => {
        throw new Error("boom");
      }
    });

    await queue.enqueuePointsCredit({
      memberId: "member-1",
      newBalance: 1,
      milestoneReached: false,
      tierChanged: false
    });
    await vi.advanceTimersByTimeAsync(WHOLE_BACKOFF_MS);

    expect(count(calls, "processPointsCredit")).toBe(5);
    expect(count(calls, "failExhausted")).toBe(0);
  });

  it("never throws out of the loop when the close itself rejects", async () => {
    const unhandled = vi.fn();

    process.on("unhandledRejection", unhandled);

    try {
      const { queue, calls } = spyService({
        delivery: async () => {
          throw new Error("boom");
        },
        closeDelivery: async () => {
          throw new Error("postgres://user:secret@host:5432 down");
        }
      });

      await queue.enqueueDelivery("delivery-1");
      await vi.advanceTimersByTimeAsync(WHOLE_BACKOFF_MS);
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));

      expect(count(calls, "failExhaustedDelivery")).toBe(1);
      expect(unhandled).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret");
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("ends a delivery that always fails transiently FAILED with JOB_RETRIES_EXHAUSTED", async () => {
    const state = {
      deliveryStatus: NotificationDeliveryStatus.QUEUED as NotificationDeliveryStatus,
      errorCode: null as string | null | undefined,
      notificationStatus: NotificationStatus.QUEUED as NotificationStatus
    };
    const notification = () => ({
      id: "notification-1",
      clinicId: "clinic-1",
      type: "SINGLE",
      header: "Hi",
      body: "There",
      actionUrl: null,
      notify: false,
      providerMessageId: null,
      status: state.notificationStatus
    });
    const prisma = {
      notificationDelivery: {
        findUnique: async () => ({
          id: "delivery-1",
          notificationId: "notification-1",
          provider: WalletProviderType.GOOGLE,
          status: state.deliveryStatus,
          notification: notification(),
          member: {
            walletObjects: [
              {
                provider: WalletProviderType.GOOGLE,
                status: WalletSyncStatus.SYNCED,
                externalObjectId: "issuer.member_1"
              }
            ]
          }
        }),
        updateMany: async ({
          where,
          data
        }: {
          where: { status: NotificationDeliveryStatus };
          data: { status: NotificationDeliveryStatus; errorCode?: string };
        }) => {
          if (state.deliveryStatus !== where.status) return { count: 0 };

          state.deliveryStatus = data.status;
          state.errorCode = data.errorCode;
          return { count: 1 };
        },
        findMany: async () => [{ status: state.deliveryStatus }]
      },
      notification: {
        updateMany: async ({ data }: { data: { status: NotificationStatus } }) => {
          state.notificationStatus = data.status;
          return { count: 1 };
        }
      },
      clinic: { update: async () => undefined }
    };
    const queue = new InlineNotificationQueue();
    const service = new NotificationService(
      prisma as never,
      {
        addObjectMessage: async () => {
          throw new WalletNotificationTransientError("google down");
        }
      } as never,
      { canMarketingPush: async () => true, recordPush: async () => undefined } as never,
      queue,
      null
    );

    queue.bind(service);
    await queue.enqueueDelivery("delivery-1");
    await vi.advanceTimersByTimeAsync(WHOLE_BACKOFF_MS);

    expect(state.deliveryStatus).toBe(NotificationDeliveryStatus.FAILED);
    expect(state.errorCode).toBe("JOB_RETRIES_EXHAUSTED");
    expect(state.notificationStatus).toBe(NotificationStatus.FAILED);
  });
});
