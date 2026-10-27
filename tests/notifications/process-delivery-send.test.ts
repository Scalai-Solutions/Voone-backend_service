import { NotificationDeliveryStatus, WalletProviderType, WalletSyncStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WalletNotificationQuotaExceededError,
  WalletNotificationTransientError
} from "../../src/common/errors/wallet.errors";
import { NotificationService } from "../../src/modules/notifications/notification.service";

interface Setup {
  notify?: boolean;
  recordPushFails?: boolean;
  /** Make the delivery row's status write reject. */
  markFails?: boolean;
  /** Per addObjectMessage call (1-based); throw to fail it. */
  send?: (call: number) => void;
}

const build = (setup: Setup = {}) => {
  const state = {
    deliveryStatus: NotificationDeliveryStatus.QUEUED as NotificationDeliveryStatus,
    errorCode: undefined as string | null | undefined,
    messages: [] as Array<{ notify: boolean }>,
    recordPushCalls: 0
  };
  const prisma = {
    notificationDelivery: {
      findUnique: async () => ({
        id: "delivery-1",
        notificationId: "notification-1",
        provider: WalletProviderType.GOOGLE,
        status: state.deliveryStatus,
        notification: {
          id: "notification-1",
          clinicId: "clinic-1",
          type: "SINGLE",
          header: "Hi",
          body: "There",
          actionUrl: null,
          notify: setup.notify ?? false,
          status: "QUEUED"
        },
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
      update: async ({
        data
      }: {
        data: { status: NotificationDeliveryStatus; errorCode?: string | null };
      }) => {
        if (setup.markFails) throw new Error("postgres://user:secret@host:5432 down");

        state.deliveryStatus = data.status;
        state.errorCode = data.errorCode;
      },
      findMany: async () => [{ status: state.deliveryStatus }]
    },
    notification: { updateMany: async () => ({ count: 1 }) },
    clinic: { update: async () => undefined }
  };
  const wallet = {
    addObjectMessage: async (_id: string, message: { notify: boolean }) => {
      state.messages.push(message);
      setup.send?.(state.messages.length);
      return { messageId: `message-${state.messages.length}` };
    }
  };
  const quota = {
    canMarketingPush: async () => true,
    recordPush: async () => {
      state.recordPushCalls += 1;
      if (setup.recordPushFails) throw new Error("redis://:secret@host:6379 down");
    }
  };
  const service = new NotificationService(
    prisma as never,
    wallet as never,
    quota as never,
    {} as never,
    null
  );

  return { service, state };
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const loggedText = () =>
  JSON.stringify([...vi.mocked(console.error).mock.calls, ...vi.mocked(console.warn).mock.calls]);

describe("processDelivery after a Google message went out", () => {
  it("marks SENT and records the push once on the normal path", async () => {
    const { service, state } = build({ notify: true });

    await service.processDelivery("delivery-1");

    expect(state.messages).toHaveLength(1);
    expect(state.recordPushCalls).toBe(1);
    expect(state.deliveryStatus).toBe(NotificationDeliveryStatus.SENT);
  });

  it("swallows a recordPush failure, keeps the delivery SENT, and does not post twice", async () => {
    const { service, state } = build({ notify: true, recordPushFails: true });

    await expect(service.processDelivery("delivery-1")).resolves.toBeUndefined();

    expect(state.messages).toHaveLength(1);
    expect(state.deliveryStatus).toBe(NotificationDeliveryStatus.SENT);
    expect(loggedText()).not.toContain("secret");
    expect(loggedText()).not.toContain("6379");
  });

  it("swallows a failure marking the delivery after the message went out", async () => {
    const { service, state } = build({ markFails: true });

    await expect(service.processDelivery("delivery-1")).resolves.toBeUndefined();

    expect(state.messages).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
    expect(loggedText()).not.toContain("secret");
    expect(loggedText()).not.toContain("5432");
  });

  it("swallows a failure marking the delivery after the quota fallback message went out", async () => {
    const { service, state } = build({
      notify: true,
      markFails: true,
      send: (call) => {
        if (call === 1) throw new WalletNotificationQuotaExceededError("quota");
      }
    });

    await expect(service.processDelivery("delivery-1")).resolves.toBeUndefined();

    expect(state.messages.map((message) => message.notify)).toEqual([true, false]);
    expect(loggedText()).not.toContain("secret");
  });

  it("still rethrows a transient failure of the send itself, so the job retries", async () => {
    const { service, state } = build({
      notify: true,
      send: () => {
        throw new WalletNotificationTransientError("google down");
      }
    });

    await expect(service.processDelivery("delivery-1")).rejects.toBeInstanceOf(
      WalletNotificationTransientError
    );
    expect(state.recordPushCalls).toBe(0);
    expect(state.deliveryStatus).toBe(NotificationDeliveryStatus.QUEUED);
  });
});
