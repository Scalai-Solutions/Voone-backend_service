import { NotificationDeliveryStatus, NotificationStatus, NotificationType } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationService } from "../../src/modules/notifications/notification.service";

type DeliveryStatus = NotificationDeliveryStatus;

interface World {
  deliveryStatus?: DeliveryStatus;
  /** Statuses of the other deliveries of the same notification. */
  others?: DeliveryStatus[];
  type?: NotificationType;
  notificationStatus?: NotificationStatus;
  providerMessageId?: string | null;
  /** Make the named table operation reject. */
  failOn?: "deliveryFind" | "deliveryUpdate" | "deliveryList";
  /**
   * The original processor (a stalled job's may still be running) finishes between the
   * handler's read and its write: the row turns SENT right after the read returns.
   */
  sentAfterRead?: "delivery" | "notification";
}

/** An in-memory stand-in for the tables the exhaustion handlers touch. */
const buildWorld = (world: World = {}) => {
  const state = {
    deliveryStatus: world.deliveryStatus ?? NotificationDeliveryStatus.QUEUED,
    errorCode: undefined as string | null | undefined,
    notificationStatus: world.notificationStatus ?? NotificationStatus.QUEUED,
    clinicIncrements: 0,
    deliveryWrites: 0
  };
  const notificationRecord = () => ({
    id: "notification-1",
    clinicId: "clinic-1",
    type: world.type ?? NotificationType.SINGLE,
    providerMessageId: world.providerMessageId ?? null,
    status: state.notificationStatus
  });
  const prisma = {
    notificationDelivery: {
      findUnique: async () => {
        if (world.failOn === "deliveryFind") throw new Error("connection to db:5432 lost");

        const snapshot = {
          id: "delivery-1",
          notificationId: "notification-1",
          status: state.deliveryStatus,
          notification: notificationRecord()
        };

        if (world.sentAfterRead === "delivery") {
          state.deliveryStatus = NotificationDeliveryStatus.SENT;
          state.notificationStatus = NotificationStatus.SENT;
        }

        return snapshot;
      },
      // Models the conditional write atomically: check and set in one synchronous step.
      updateMany: async ({
        where,
        data
      }: {
        where: { id: string; status: DeliveryStatus };
        data: { status: DeliveryStatus; errorCode?: string | null };
      }) => {
        if (world.failOn === "deliveryUpdate") throw new Error("postgres://user:secret@host down");
        if (state.deliveryStatus !== where.status) return { count: 0 };

        state.deliveryWrites += 1;
        state.deliveryStatus = data.status;
        state.errorCode = data.errorCode;
        return { count: 1 };
      },
      update: async ({ data }: { data: { status: DeliveryStatus; errorCode?: string | null } }) => {
        if (world.failOn === "deliveryUpdate") throw new Error("postgres://user:secret@host down");

        state.deliveryWrites += 1;
        state.deliveryStatus = data.status;
        state.errorCode = data.errorCode;
      },
      findMany: async () => {
        if (world.failOn === "deliveryList") throw new Error("connection to db:5432 lost");

        return [
          { status: state.deliveryStatus },
          ...(world.others ?? []).map((status) => ({ status }))
        ];
      }
    },
    notification: {
      findUnique: async () => {
        const snapshot = notificationRecord();

        if (world.sentAfterRead === "notification") {
          state.notificationStatus = NotificationStatus.SENT;
        }

        return snapshot;
      },
      update: async ({ data }: { data: { status?: NotificationStatus } }) => {
        if (data.status) state.notificationStatus = data.status;
      },
      updateMany: async ({
        where,
        data
      }: {
        where: { status?: { notIn?: NotificationStatus[]; in?: NotificationStatus[] } };
        data: { status?: NotificationStatus };
      }) => {
        if (where.status?.notIn?.includes(state.notificationStatus)) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(state.notificationStatus)) {
          return { count: 0 };
        }
        if (data.status) state.notificationStatus = data.status;
        return { count: 1 };
      }
    },
    clinic: {
      update: async () => {
        state.clinicIncrements += 1;
      }
    }
  };
  const service = new NotificationService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    null
  );

  return { service, state };
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("failExhaustedDelivery", () => {
  it("marks a QUEUED delivery FAILED with JOB_RETRIES_EXHAUSTED and finalises a notification whose only delivery it was", async () => {
    const { service, state } = buildWorld();

    await service.failExhaustedDelivery("delivery-1");

    expect(state.deliveryStatus).toBe(NotificationDeliveryStatus.FAILED);
    expect(state.errorCode).toBe("JOB_RETRIES_EXHAUSTED");
    expect(state.notificationStatus).toBe(NotificationStatus.FAILED);
    expect(state.clinicIncrements).toBe(0);
  });

  it("makes the notification PARTIAL_FAILED, and counts it, when another delivery already went out", async () => {
    const { service, state } = buildWorld({ others: [NotificationDeliveryStatus.SENT] });

    await service.failExhaustedDelivery("delivery-1");

    expect(state.deliveryStatus).toBe(NotificationDeliveryStatus.FAILED);
    expect(state.notificationStatus).toBe(NotificationStatus.PARTIAL_FAILED);
    expect(state.clinicIncrements).toBe(1);
  });

  it("leaves the notification open while a sibling delivery is still QUEUED", async () => {
    const { service, state } = buildWorld({
      notificationStatus: NotificationStatus.PROCESSING,
      others: [NotificationDeliveryStatus.QUEUED]
    });

    await service.failExhaustedDelivery("delivery-1");

    expect(state.deliveryStatus).toBe(NotificationDeliveryStatus.FAILED);
    expect(state.notificationStatus).toBe(NotificationStatus.PROCESSING);
  });

  it.each([
    NotificationDeliveryStatus.SENT,
    NotificationDeliveryStatus.SKIPPED,
    NotificationDeliveryStatus.FAILED,
    NotificationDeliveryStatus.DOWNGRADED
  ])("does nothing to a delivery that is already %s", async (status) => {
    const { service, state } = buildWorld({
      deliveryStatus: status,
      notificationStatus: NotificationStatus.SENT
    });

    await service.failExhaustedDelivery("delivery-1");

    expect(state.deliveryStatus).toBe(status);
    expect(state.deliveryWrites).toBe(0);
    expect(state.errorCode).toBeUndefined();
    expect(state.notificationStatus).toBe(NotificationStatus.SENT);
    expect(state.clinicIncrements).toBe(0);
  });

  it("marks the delivery but does not revive a CANCELLED notification", async () => {
    const { service, state } = buildWorld({ notificationStatus: NotificationStatus.CANCELLED });

    await service.failExhaustedDelivery("delivery-1");

    expect(state.deliveryStatus).toBe(NotificationDeliveryStatus.FAILED);
    expect(state.notificationStatus).toBe(NotificationStatus.CANCELLED);
  });

  it("leaves a delivery that turned SENT between the read and the write SENT, and does not refresh the notification", async () => {
    const { service, state } = buildWorld({ sentAfterRead: "delivery" });

    await service.failExhaustedDelivery("delivery-1");

    expect(state.deliveryStatus).toBe(NotificationDeliveryStatus.SENT);
    expect(state.errorCode).toBeUndefined();
    expect(state.deliveryWrites).toBe(0);
    // A refresh from the stale snapshot would have moved it to FAILED.
    expect(state.notificationStatus).toBe(NotificationStatus.SENT);
  });

  it("swallows a database error and logs without the error message", async () => {
    for (const failOn of ["deliveryFind", "deliveryUpdate"] as const) {
      const { service } = buildWorld({ failOn });

      await expect(service.failExhaustedDelivery("delivery-1")).resolves.toBeUndefined();
    }

    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);

    expect(console.error).toHaveBeenCalledTimes(2);
    expect(logged).toContain("delivery-1");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("5432");
  });
});

describe("failExhaustedNotification", () => {
  it.each([NotificationStatus.QUEUED, NotificationStatus.PROCESSING])(
    "marks a %s notification with no delivery out FAILED",
    async (notificationStatus) => {
      const { service, state } = buildWorld({
        notificationStatus,
        type: NotificationType.BROADCAST,
        deliveryStatus: NotificationDeliveryStatus.FAILED
      });

      await service.failExhaustedNotification("notification-1");

      expect(state.notificationStatus).toBe(NotificationStatus.FAILED);
      expect(state.clinicIncrements).toBe(0);
    }
  );

  it("marks it PARTIAL_FAILED, counted once, when a delivery already went out", async () => {
    const { service, state } = buildWorld({
      notificationStatus: NotificationStatus.PROCESSING,
      type: NotificationType.BROADCAST,
      deliveryStatus: NotificationDeliveryStatus.QUEUED,
      others: [NotificationDeliveryStatus.SENT]
    });

    await service.failExhaustedNotification("notification-1");

    expect(state.notificationStatus).toBe(NotificationStatus.PARTIAL_FAILED);
    expect(state.clinicIncrements).toBe(1);
  });

  it.each([
    NotificationStatus.SENT,
    NotificationStatus.PARTIAL_FAILED,
    NotificationStatus.FAILED,
    NotificationStatus.CANCELLED
  ])("does nothing to a notification that is already %s", async (notificationStatus) => {
    const { service, state } = buildWorld({
      notificationStatus,
      type: NotificationType.BROADCAST
    });

    await service.failExhaustedNotification("notification-1");

    expect(state.notificationStatus).toBe(notificationStatus);
    expect(state.clinicIncrements).toBe(0);
  });

  it("does not overwrite a notification that turned SENT between the read and the write", async () => {
    const { service, state } = buildWorld({
      notificationStatus: NotificationStatus.PROCESSING,
      type: NotificationType.BROADCAST,
      deliveryStatus: NotificationDeliveryStatus.FAILED,
      sentAfterRead: "notification"
    });

    await service.failExhaustedNotification("notification-1");

    expect(state.notificationStatus).toBe(NotificationStatus.SENT);
    expect(state.clinicIncrements).toBe(0);
  });

  it("swallows a database error", async () => {
    const { service } = buildWorld({ failOn: "deliveryList" });

    await expect(service.failExhaustedNotification("notification-1")).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("5432");
  });
});
