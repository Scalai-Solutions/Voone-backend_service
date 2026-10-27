import { NotificationStatus, NotificationType } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationService } from "../../src/modules/notifications/notification.service";

interface World {
  status?: NotificationStatus;
  googleClass?: boolean;
  /** The clinic cancels right after processNotification has read the notification. */
  cancelAfterRead?: boolean;
  /** A stalled job's original processor finishes the broadcast right after the read. */
  finishedAfterRead?: boolean;
  /** The clinic cancels while the Google class message is being written. */
  cancelDuringSend?: boolean;
  /** The clinic cancels while the Apple recipients are being looked up (Apple-only clinic). */
  cancelDuringFanOut?: boolean;
  sendFails?: boolean;
  /** The first send fails, later ones work (a transient error, then the retry). */
  sendFailsOnce?: boolean;
  /** The first write of SENT rejects (database hiccup right after the message went out). */
  statusWriteFailsOnce?: boolean;
  /** Every write of the provider message id on its own rejects. */
  idWriteFails?: boolean;
  /** The monthly counter write rejects. */
  countFails?: boolean;
}

type Where = { status?: { notIn?: NotificationStatus[]; in?: NotificationStatus[] } };

const build = (world: World = {}) => {
  const state = {
    status: world.status ?? NotificationStatus.QUEUED,
    providerMessageId: null as string | null,
    sent: [] as string[],
    removed: [] as Array<{ target: unknown; messageId: string }>,
    increments: 0,
    fanOutLookups: 0,
    sendAttempts: 0,
    statusWriteFailed: false
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
          providerMessageId: state.providerMessageId,
          status: state.status
        };

        if (world.cancelAfterRead) state.status = NotificationStatus.CANCELLED;
        if (world.finishedAfterRead) state.status = NotificationStatus.SENT;

        return snapshot;
      },
      // Atomic: the check and the write are one synchronous step, like one SQL statement.
      updateMany: async ({
        where,
        data
      }: {
        where: Where;
        data: { status?: NotificationStatus; providerMessageId?: string };
      }) => {
        if (world.idWriteFails && data.providerMessageId && !data.status) {
          throw new Error("postgres://user:secret@host:5432 down");
        }
        if (
          world.statusWriteFailsOnce &&
          data.status === NotificationStatus.SENT &&
          !state.statusWriteFailed
        ) {
          state.statusWriteFailed = true;
          throw new Error("postgres://user:secret@host:5432 down");
        }
        if (where.status?.notIn?.includes(state.status)) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(state.status)) return { count: 0 };
        if (data.status) state.status = data.status;
        if (data.providerMessageId) state.providerMessageId = data.providerMessageId;
        return { count: 1 };
      },
      // Unconditional on purpose: the fix must not depend on it for status writes.
      update: async ({ data }: { data: { status?: NotificationStatus } }) => {
        if (data.status) state.status = data.status;
      }
    },
    walletClass: {
      findFirst: async () => (world.googleClass === false ? null : { externalClassId: "class-1" })
    },
    walletObject: {
      findMany: async () => {
        state.fanOutLookups += 1;
        if (world.cancelDuringFanOut) state.status = NotificationStatus.CANCELLED;
        return [];
      }
    },
    notificationDelivery: { findMany: async () => [] },
    clinic: {
      update: async () => {
        if (world.countFails) throw new Error("postgres://user:secret@host:5432 down");

        state.increments += 1;
      }
    }
  };
  const wallet = {
    addClassMessage: async () => {
      state.sendAttempts += 1;
      if (world.cancelDuringSend) state.status = NotificationStatus.CANCELLED;
      if (world.sendFails || (world.sendFailsOnce && state.sendAttempts === 1)) {
        throw new Error("google down");
      }

      state.sent.push("message-1");
      return { messageId: "message-1" };
    },
    removeMessage: async (target: unknown, messageId: string) => {
      state.removed.push({ target, messageId });
    }
  };
  const service = new NotificationService(
    prisma as never,
    wallet as never,
    {} as never,
    { enqueueDelivery: async () => undefined } as never,
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

describe("processNotification and a cancelled broadcast", () => {
  it("sends a normal broadcast, marks it SENT with its message id, and counts it once", async () => {
    const { service, state } = build();

    await service.processNotification("notification-1");

    expect(state.sent).toEqual(["message-1"]);
    expect(state.status).toBe(NotificationStatus.SENT);
    expect(state.providerMessageId).toBe("message-1");
    expect(state.increments).toBe(1);
    expect(state.removed).toEqual([]);
  });

  it("still sends on a retry after a FAILED attempt", async () => {
    const { service, state } = build({ status: NotificationStatus.FAILED });

    await service.processNotification("notification-1");

    expect(state.sent).toEqual(["message-1"]);
    expect(state.status).toBe(NotificationStatus.SENT);
  });

  it("marks the broadcast FAILED and rethrows when the send fails", async () => {
    const { service, state } = build({ sendFails: true });

    await expect(service.processNotification("notification-1")).rejects.toThrow("google down");
    expect(state.status).toBe(NotificationStatus.FAILED);
    expect(state.increments).toBe(0);
  });

  it("sends nothing when it is cancelled between the status read and the PROCESSING write", async () => {
    const { service, state } = build({ cancelAfterRead: true });

    await service.processNotification("notification-1");

    expect(state.sent).toEqual([]);
    expect(state.status).toBe(NotificationStatus.CANCELLED);
    expect(state.increments).toBe(0);
    expect(state.fanOutLookups).toBe(0);
  });

  it("does not send when another worker finished it between the read and the PROCESSING write", async () => {
    const { service, state } = build({ finishedAfterRead: true });

    await service.processNotification("notification-1");

    expect(state.sent).toEqual([]);
    expect(state.status).toBe(NotificationStatus.SENT);
    expect(state.increments).toBe(0);
  });

  it("does not reopen a broadcast cancelled while the class message is being written, removes the message, and does not count it", async () => {
    const { service, state } = build({ cancelDuringSend: true });

    await service.processNotification("notification-1");

    expect(state.status).toBe(NotificationStatus.CANCELLED);
    expect(state.providerMessageId).toBe("message-1");
    expect(state.removed).toEqual([
      { target: { kind: "class", id: "class-1" }, messageId: "message-1" }
    ]);
    expect(state.increments).toBe(0);
    expect(state.fanOutLookups).toBe(0);
  });

  it("does not turn a cancelled Apple-only broadcast with nobody to send to into SENT", async () => {
    const { service, state } = build({ googleClass: false, cancelDuringFanOut: true });

    await service.processNotification("notification-1");

    expect(state.status).toBe(NotificationStatus.CANCELLED);
    expect(state.increments).toBe(0);
  });

  it("marks an Apple-only broadcast with nobody to send to SENT, uncounted", async () => {
    const { service, state } = build({ googleClass: false });

    await service.processNotification("notification-1");

    expect(state.status).toBe(NotificationStatus.SENT);
    expect(state.increments).toBe(0);
  });

  it("does not overwrite CANCELLED with FAILED when the send fails after a cancel", async () => {
    const { service, state } = build({ sendFails: true, cancelDuringSend: true });

    await expect(service.processNotification("notification-1")).rejects.toThrow("google down");
    expect(state.status).toBe(NotificationStatus.CANCELLED);
  });

  it("does not send again on the retry after the SENT write failed once the message was out", async () => {
    const { service, state } = build({ statusWriteFailsOnce: true });

    await expect(service.processNotification("notification-1")).resolves.toBeUndefined();

    expect(state.sendAttempts).toBe(1);
    expect(state.providerMessageId).toBe("message-1");
    expect(state.status).toBe(NotificationStatus.PROCESSING);

    // The queue would only retry if the first run threw; a retry must still not resend.
    await service.processNotification("notification-1");

    expect(state.sendAttempts).toBe(1);
    expect(state.status).toBe(NotificationStatus.SENT);
    // Counted by the first run; the retry cannot know and must not count again.
    expect(state.increments).toBe(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret");
  });

  it("does not mark the broadcast FAILED, rethrow or resend when the counter write fails after the send", async () => {
    const { service, state } = build({ countFails: true });

    await expect(service.processNotification("notification-1")).resolves.toBeUndefined();

    expect(state.status).toBe(NotificationStatus.SENT);
    expect(state.providerMessageId).toBe("message-1");

    await service.processNotification("notification-1");

    expect(state.sendAttempts).toBe(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret");
  });

  it("finalises a broadcast that has a provider message id but never reached SENT, without sending or counting", async () => {
    const { service, state } = build({ status: NotificationStatus.FAILED });

    state.providerMessageId = "message-0";

    await service.processNotification("notification-1");

    expect(state.sendAttempts).toBe(0);
    expect(state.status).toBe(NotificationStatus.SENT);
    expect(state.increments).toBe(0);
  });

  it("retries normally after a pre-send failure: FAILED, then one message and SENT", async () => {
    const { service, state } = build({ sendFailsOnce: true });

    await expect(service.processNotification("notification-1")).rejects.toThrow("google down");
    expect(state.status).toBe(NotificationStatus.FAILED);
    expect(state.providerMessageId).toBeNull();

    await service.processNotification("notification-1");

    expect(state.sendAttempts).toBe(2);
    expect(state.status).toBe(NotificationStatus.SENT);
    expect(state.increments).toBe(1);
  });

  it("still removes the class message when the id write fails after a cancel during the send", async () => {
    const { service, state } = build({ cancelDuringSend: true, idWriteFails: true });

    await expect(service.processNotification("notification-1")).resolves.toBeUndefined();

    expect(state.status).toBe(NotificationStatus.CANCELLED);
    expect(state.removed).toEqual([
      { target: { kind: "class", id: "class-1" }, messageId: "message-1" }
    ]);
    expect(state.increments).toBe(0);
  });
});
