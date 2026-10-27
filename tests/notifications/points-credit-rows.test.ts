import {
  NotificationDeliveryStatus,
  NotificationStatus,
  WalletProviderType,
  WalletSyncStatus
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WalletNotificationNotFoundError,
  WalletNotificationQuotaExceededError,
  WalletNotificationTransientError
} from "../../src/common/errors/wallet.errors";
import { NotificationService } from "../../src/modules/notifications/notification.service";

interface Created {
  type: string;
  status?: NotificationStatus;
  deliveries: Array<{ status: NotificationDeliveryStatus; errorCode?: string | null }>;
}

interface Setup {
  synced?: boolean;
  /** Called for each patchPoints call, in order; throw to fail it. */
  patch?: (call: number) => void;
  createFails?: boolean;
  notifyOnCredit?: "NEVER" | "ALWAYS";
}

const build = (setup: Setup = {}) => {
  const rows: Created[] = [];
  const patches: Array<{ notify: boolean }> = [];
  const notificationWrites: unknown[] = [];
  const prisma = {
    member: {
      findFirst: async () => ({
        id: "member-1",
        clinicId: "clinic-1",
        tier: null,
        walletObjects:
          setup.synced === false
            ? []
            : [
                {
                  provider: WalletProviderType.GOOGLE,
                  status: WalletSyncStatus.SYNCED,
                  externalObjectId: "issuer.member_1"
                }
              ]
      })
    },
    onboardingProgram: { count: async () => 0 },
    clinicNotificationSettings: {
      upsert: async () => ({ notifyOnCredit: setup.notifyOnCredit ?? "NEVER" })
    },
    notification: {
      create: async ({
        data
      }: {
        data: {
          type: string;
          status?: NotificationStatus;
          deliveries: { create: { status: NotificationDeliveryStatus; errorCode?: string } };
        };
      }) => {
        if (setup.createFails) throw new Error("postgres://user:secret@host:5432 down");

        rows.push({
          type: data.type,
          status: data.status,
          deliveries: [data.deliveries.create]
        });

        return {
          id: "notification-1",
          clinicId: "clinic-1",
          type: data.type,
          status: data.status ?? NotificationStatus.QUEUED,
          deliveries: [{ id: "delivery-1" }]
        };
      },
      update: async (args: unknown) => {
        notificationWrites.push(args);
      },
      updateMany: async (args: unknown) => {
        notificationWrites.push(args);
        return { count: 1 };
      }
    },
    notificationDelivery: {
      update: async (args: unknown) => {
        notificationWrites.push(args);
      },
      findMany: async () => [{ status: NotificationDeliveryStatus.SENT }]
    }
  };
  const wallet = {
    patchPoints: async (_id: string, patch: { notify: boolean }) => {
      patches.push(patch);
      setup.patch?.(patches.length);
    }
  };
  const quota = { canPush: async () => true, recordPush: async () => undefined };
  const service = new NotificationService(
    prisma as never,
    wallet as never,
    quota as never,
    {} as never
  );

  return { service, rows, patches };
};

const job = { memberId: "member-1", newBalance: 120, milestoneReached: false, tierChanged: false };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("processPointsCredit rows", () => {
  it("leaves no notification or delivery row behind when the patch fails, and rethrows", async () => {
    const { service, rows } = build({
      patch: () => {
        throw new WalletNotificationTransientError("google down");
      }
    });

    await expect(service.processPointsCredit(job)).rejects.toBeInstanceOf(
      WalletNotificationTransientError
    );
    expect(rows).toEqual([]);
  });

  it("leaves no row behind when the quota fallback patch fails too, and rethrows", async () => {
    const { service, rows } = build({
      notifyOnCredit: "ALWAYS",
      patch: (call) => {
        throw call === 1
          ? new WalletNotificationQuotaExceededError("quota")
          : new WalletNotificationTransientError("google down");
      }
    });

    await expect(service.processPointsCredit(job)).rejects.toBeInstanceOf(
      WalletNotificationTransientError
    );
    expect(rows).toEqual([]);
  });

  it("creates exactly one SENT row after a successful patch", async () => {
    const { service, rows, patches } = build();

    await service.processPointsCredit(job);

    expect(patches).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("POINTS");
    expect(rows[0].status).toBe(NotificationStatus.SENT);
    expect(rows[0].deliveries).toEqual([
      expect.objectContaining({ status: NotificationDeliveryStatus.SENT })
    ]);
  });

  it("records a TIER row when the tier changed", async () => {
    const { service, rows } = build();

    await service.processPointsCredit({ ...job, tierChanged: true });

    expect(rows.map((row) => row.type)).toEqual(["TIER"]);
  });

  it("creates one DOWNGRADED row when the quota is exceeded and the silent patch works", async () => {
    const { service, rows, patches } = build({
      notifyOnCredit: "ALWAYS",
      patch: (call) => {
        if (call === 1) throw new WalletNotificationQuotaExceededError("quota");
      }
    });

    await service.processPointsCredit(job);

    expect(patches.map((patch) => patch.notify)).toEqual([true, false]);
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveries).toEqual([
      expect.objectContaining({
        status: NotificationDeliveryStatus.DOWNGRADED,
        errorCode: "QUOTA_EXCEEDED"
      })
    ]);
  });

  it("creates one SKIPPED NOT_FOUND row when Google no longer has the object", async () => {
    const { service, rows } = build({
      patch: () => {
        throw new WalletNotificationNotFoundError("gone");
      }
    });

    await service.processPointsCredit(job);

    expect(rows).toHaveLength(1);
    expect(rows[0].deliveries).toEqual([
      expect.objectContaining({
        status: NotificationDeliveryStatus.SKIPPED,
        errorCode: "NOT_FOUND"
      })
    ]);
  });

  it("creates one SKIPPED NO_GOOGLE_PASS row without calling the wallet when nothing is synced", async () => {
    const { service, rows, patches } = build({ synced: false });

    await service.processPointsCredit(job);

    expect(patches).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveries).toEqual([
      expect.objectContaining({
        status: NotificationDeliveryStatus.SKIPPED,
        errorCode: "NO_GOOGLE_PASS"
      })
    ]);
  });

  it("does not rethrow, and logs without the message, when the row cannot be created after a successful patch", async () => {
    const { service, patches } = build({ createFails: true });

    await expect(service.processPointsCredit(job)).resolves.toBeUndefined();

    expect(patches).toHaveLength(1);
    expect(console.error).toHaveBeenCalledTimes(1);

    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);

    expect(logged).toContain("member-1");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("5432");
  });
});
