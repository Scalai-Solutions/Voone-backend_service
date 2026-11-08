import {
  NotificationDeliveryStatus,
  NotificationStatus,
  NotificationType,
  WalletProviderType
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationService } from "../../src/modules/notifications/notification.service";

interface World {
  status?: NotificationStatus;
  /** Set on a broadcast sent the old way, as one shared Google class message. */
  providerMessageId?: string;
  /** Members holding a synced card, per wallet. */
  google?: string[];
  apple?: string[];
  /** The clinic cancels right after processNotification has read the notification. */
  cancelAfterRead?: boolean;
  /** A stalled job's original processor finishes the broadcast right after the read. */
  finishedAfterRead?: boolean;
  /** The clinic cancels while the recipients are being looked up. */
  cancelDuringFanOut?: boolean;
}

type Where = { status?: { notIn?: NotificationStatus[]; in?: NotificationStatus[] } };
type Delivery = {
  id: string;
  memberId: string;
  provider: WalletProviderType;
  status: NotificationDeliveryStatus;
};

const build = (world: World = {}) => {
  const state = {
    status: world.status ?? NotificationStatus.QUEUED,
    deliveries: [] as Delivery[],
    enqueued: [] as string[],
    classMessages: 0,
    increments: 0,
    fanOutLookups: 0
  };
  const prisma = {
    notification: {
      findUnique: async () => {
        const snapshot = {
          id: "notification-1",
          clinicId: "clinic-1",
          type: NotificationType.BROADCAST,
          header: "Hi",
          body: "There",
          actionUrl: null,
          notify: false,
          providerMessageId: world.providerMessageId ?? null,
          status: state.status
        };

        if (world.cancelAfterRead) state.status = NotificationStatus.CANCELLED;
        if (world.finishedAfterRead) state.status = NotificationStatus.SENT;

        return snapshot;
      },
      // Atomic: the check and the write are one synchronous step, like one SQL statement.
      updateMany: async ({ where, data }: { where: Where; data: { status?: NotificationStatus } }) => {
        if (where.status?.notIn?.includes(state.status)) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(state.status)) return { count: 0 };
        if (data.status) state.status = data.status;
        return { count: 1 };
      }
    },
    walletObject: {
      findMany: async ({ where }: { where: { provider: WalletProviderType } }) => {
        state.fanOutLookups += 1;
        if (world.cancelDuringFanOut) state.status = NotificationStatus.CANCELLED;
        const members = where.provider === WalletProviderType.GOOGLE ? world.google : world.apple;
        return (members ?? []).map((memberId) => ({ memberId }));
      }
    },
    notificationDelivery: {
      findMany: async ({ where }: { where: { status?: NotificationDeliveryStatus } }) =>
        state.deliveries.filter((d) => !where.status || d.status === where.status),
      createMany: async ({ data }: { data: Array<Omit<Delivery, "id">> }) => {
        for (const row of data) {
          state.deliveries.push({ ...row, id: `${row.provider}-${row.memberId}` });
        }
      }
    },
    clinic: {
      update: async () => {
        state.increments += 1;
      }
    }
  };
  const wallet = {
    addClassMessage: async () => {
      state.classMessages += 1;
      return { messageId: "class-message" };
    }
  };
  const service = new NotificationService(
    prisma as never,
    wallet as never,
    {} as never,
    {
      enqueueDelivery: async (id: string) => {
        state.enqueued.push(id);
      }
    } as never,
    null
  );

  return { service, state };
};

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a broadcast", () => {
  it("goes to each card on its own, Google included, and never as a shared class message", async () => {
    const { service, state } = build({ google: ["m1", "m2"], apple: ["m1"] });

    await service.processNotification("notification-1");

    expect(state.classMessages).toBe(0);
    expect(state.deliveries.map((d) => d.id).sort()).toEqual([
      "APPLE-m1",
      "GOOGLE-m1",
      "GOOGLE-m2"
    ]);
    expect(state.enqueued.sort()).toEqual(["APPLE-m1", "GOOGLE-m1", "GOOGLE-m2"]);
    // The deliveries finish it and count it, not this run.
    expect(state.status).toBe(NotificationStatus.PROCESSING);
    expect(state.increments).toBe(0);
  });

  it("creates no second delivery for anyone on a retry", async () => {
    const { service, state } = build({ google: ["m1"], apple: ["m1"] });

    await service.processNotification("notification-1");
    await service.processNotification("notification-1");

    expect(state.deliveries).toHaveLength(2);
  });

  it("still fans out on a retry after a FAILED attempt", async () => {
    const { service, state } = build({ status: NotificationStatus.FAILED, google: ["m1"] });

    await service.processNotification("notification-1");

    expect(state.deliveries.map((d) => d.id)).toEqual(["GOOGLE-m1"]);
    expect(state.status).toBe(NotificationStatus.PROCESSING);
  });

  it("sends nothing when it is cancelled between the status read and the PROCESSING write", async () => {
    const { service, state } = build({ cancelAfterRead: true, google: ["m1"] });

    await service.processNotification("notification-1");

    expect(state.deliveries).toEqual([]);
    expect(state.status).toBe(NotificationStatus.CANCELLED);
    expect(state.fanOutLookups).toBe(0);
  });

  it("does not fan out when another worker finished it between the read and the PROCESSING write", async () => {
    const { service, state } = build({ finishedAfterRead: true, google: ["m1"] });

    await service.processNotification("notification-1");

    expect(state.deliveries).toEqual([]);
    expect(state.status).toBe(NotificationStatus.SENT);
    expect(state.increments).toBe(0);
  });

  it("marks a broadcast with nobody to send to SENT, uncounted", async () => {
    const { service, state } = build();

    await service.processNotification("notification-1");

    expect(state.status).toBe(NotificationStatus.SENT);
    expect(state.increments).toBe(0);
  });

  it("does not turn a broadcast cancelled during the fan-out, with nobody to send to, into SENT", async () => {
    const { service, state } = build({ cancelDuringFanOut: true });

    await service.processNotification("notification-1");

    expect(state.status).toBe(NotificationStatus.CANCELLED);
    expect(state.increments).toBe(0);
  });
});

describe("a broadcast sent before broadcasts went per card", () => {
  it("is finalised without sending it to Google again, and still reaches Apple", async () => {
    const { service, state } = build({
      status: NotificationStatus.PROCESSING,
      providerMessageId: "class-message-0",
      google: ["m1"],
      apple: ["m1"]
    });

    await service.processNotification("notification-1");

    expect(state.classMessages).toBe(0);
    expect(state.deliveries.map((d) => d.id)).toEqual(["APPLE-m1"]);
    expect(state.status).toBe(NotificationStatus.SENT);
    expect(state.increments).toBe(0);
  });
});
