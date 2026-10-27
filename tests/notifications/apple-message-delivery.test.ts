import {
  NotificationDeliveryStatus,
  NotificationStatus,
  NotificationType,
  WalletProviderType,
  WalletSyncStatus
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "../../src/modules/auth/rbac";
import { formatCardMessage } from "../../src/wallet/engine/card-message";
import { NotificationService } from "../../src/modules/notifications/notification.service";

type Status = NotificationDeliveryStatus;

interface World {
  type?: NotificationType;
  notificationStatus?: NotificationStatus;
  walletObjects?: Array<{ provider: WalletProviderType; status: WalletSyncStatus }>;
  /** Statuses of the other deliveries of the same notification. */
  otherDeliveries?: Status[];
}

/** An in-memory stand-in for the handful of tables processDelivery touches, with an event log. */
const buildWorld = (world: World = {}) => {
  const log: string[] = [];
  const state = {
    deliveryStatus: NotificationDeliveryStatus.QUEUED as Status,
    errorCode: undefined as string | null | undefined,
    messages: [] as Array<{ memberId: string; header: string; body: string; sentAt: Date }>,
    clinicIncrements: 0,
    notificationStatus: undefined as NotificationStatus | undefined
  };
  const delivery = {
    id: "delivery-apple",
    notificationId: "notification-1",
    memberId: "member-1",
    provider: WalletProviderType.APPLE,
    status: NotificationDeliveryStatus.QUEUED,
    notification: {
      id: "notification-1",
      clinicId: "clinic-1",
      type: world.type ?? NotificationType.SINGLE,
      header: "Título",
      body: "cuerpo",
      actionUrl: null,
      notify: true,
      status: world.notificationStatus ?? NotificationStatus.QUEUED
    },
    member: {
      walletObjects: (
        world.walletObjects ?? [
          { provider: WalletProviderType.APPLE, status: WalletSyncStatus.SYNCED }
        ]
      ).map((object) => ({ ...object, externalObjectId: "apple-serial-1" }))
    }
  };
  const prisma = {
    notificationDelivery: {
      findUnique: async () => delivery,
      update: async ({ data }: { data: { status: Status; errorCode?: string | null } }) => {
        log.push(`mark:${data.status}`);
        state.deliveryStatus = data.status;
        state.errorCode = data.errorCode;
      },
      findMany: async () => [
        { status: state.deliveryStatus },
        ...(world.otherDeliveries ?? []).map((status) => ({ status }))
      ]
    },
    memberWalletMessage: {
      upsert: async ({
        create
      }: {
        create: { memberId: string; header: string; body: string; sentAt: Date };
      }) => {
        log.push("upsert");
        state.messages.push(create);
      }
    },
    notification: {
      update: async ({ data }: { data: { status?: NotificationStatus } }) => {
        if (data.status) state.notificationStatus = data.status;
      }
    },
    clinic: {
      update: async () => {
        state.clinicIncrements += 1;
      }
    }
  };

  return { prisma, log, state };
};

const quotaSpy = () => {
  const calls: string[] = [];

  return {
    calls,
    quota: {
      canMarketingPush: async () => {
        calls.push("canMarketingPush");
        return true;
      },
      canPush: async () => {
        calls.push("canPush");
        return true;
      },
      recordPush: async () => {
        calls.push("recordPush");
      }
    }
  };
};

const serviceFor = (
  prisma: unknown,
  refreshMemberCard: ((memberId: string) => Promise<void>) | null,
  quota: unknown = quotaSpy().quota,
  wallet: unknown = {}
) =>
  new NotificationService(
    prisma as never,
    wallet as never,
    quota as never,
    {} as never,
    refreshMemberCard ? { refreshMemberCard } : null
  );

describe("processDelivery for an Apple card", () => {
  it("stores the message, refreshes the card once, and marks SENT only after the refresh resolved", async () => {
    const { prisma, log, state } = buildWorld();
    const refreshed: string[] = [];
    const service = serviceFor(prisma, async (memberId) => {
      log.push("refresh:start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      refreshed.push(memberId);
      log.push("refresh:end");
    });

    await service.processDelivery("delivery-apple");

    expect(refreshed).toEqual(["member-1"]);
    expect(log).toEqual(["upsert", "refresh:start", "refresh:end", "mark:SENT"]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      memberId: "member-1",
      header: "Título",
      body: "cuerpo"
    });
    expect(state.messages[0].sentAt).toBeInstanceOf(Date);
    expect(state.deliveryStatus).toBe(NotificationDeliveryStatus.SENT);
  });

  it("marks FAILED when the refresh throws, keeps the stored message and does not rethrow", async () => {
    const { prisma, log, state } = buildWorld();
    const service = serviceFor(prisma, async () => {
      throw new Error("apns down");
    });

    await expect(service.processDelivery("delivery-apple")).resolves.toBeUndefined();

    expect(log).toEqual(["upsert", "mark:FAILED"]);
    expect(state.deliveryStatus).toBe(NotificationDeliveryStatus.FAILED);
    expect(state.errorCode).toBe("APPLE_REFRESH_FAILED");
    expect(state.messages).toHaveLength(1);
  });

  it("marks FAILED, without storing anything, when this deployment cannot refresh Apple cards", async () => {
    const { prisma, state } = buildWorld();

    await serviceFor(prisma, null).processDelivery("delivery-apple");

    expect(state.deliveryStatus).toBe(NotificationDeliveryStatus.FAILED);
    expect(state.errorCode).toBe("APPLE_REFRESH_UNAVAILABLE");
    expect(state.messages).toHaveLength(0);
  });

  it("marks SKIPPED NO_APPLE_PASS without refreshing when the member has no synced Apple object", async () => {
    for (const walletObjects of [
      [],
      [{ provider: WalletProviderType.GOOGLE, status: WalletSyncStatus.SYNCED }],
      [{ provider: WalletProviderType.APPLE, status: WalletSyncStatus.PENDING }]
    ]) {
      const { prisma, log, state } = buildWorld({ walletObjects });
      let refreshes = 0;
      const service = serviceFor(prisma, async () => {
        refreshes += 1;
      });

      await service.processDelivery("delivery-apple");

      expect(refreshes).toBe(0);
      expect(log).toEqual(["mark:SKIPPED"]);
      expect(state.errorCode).toBe("NO_APPLE_PASS");
      expect(state.messages).toHaveLength(0);
    }
  });

  it("never touches the Google notification quota or the Google API", async () => {
    const { prisma } = buildWorld();
    const { calls, quota } = quotaSpy();
    const wallet = new Proxy(
      {},
      {
        get: (_target, name) => () => {
          throw new Error(`Google wallet API ${String(name)} must not be called for Apple`);
        }
      }
    );

    await serviceFor(prisma, async () => undefined, quota, wallet).processDelivery(
      "delivery-apple"
    );

    expect(calls).toEqual([]);
  });

  it("does not count a send whose only delivery was skipped, but counts an Apple SENT one", async () => {
    const skipped = buildWorld({ walletObjects: [] });

    await serviceFor(skipped.prisma, async () => undefined).processDelivery("delivery-apple");

    expect(skipped.state.notificationStatus).toBe(NotificationStatus.SENT);
    expect(skipped.state.clinicIncrements).toBe(0);

    const sent = buildWorld();

    await serviceFor(sent.prisma, async () => undefined).processDelivery("delivery-apple");

    expect(sent.state.notificationStatus).toBe(NotificationStatus.SENT);
    expect(sent.state.clinicIncrements).toBe(1);
  });

  it("counts a notification once when Google already sent and Apple skipped", async () => {
    const world = buildWorld({
      walletObjects: [],
      otherDeliveries: [NotificationDeliveryStatus.SENT]
    });

    await serviceFor(world.prisma, async () => undefined).processDelivery("delivery-apple");

    expect(world.state.clinicIncrements).toBe(1);
  });

  it("does not count a failed Apple delivery as a real send", async () => {
    const world = buildWorld();

    await serviceFor(world.prisma, async () => {
      throw new Error("x");
    }).processDelivery("delivery-apple");

    expect(world.state.notificationStatus).toBe(NotificationStatus.FAILED);
    expect(world.state.clinicIncrements).toBe(0);
  });

  it("keeps a broadcast SENT-or-partial, never FAILED, when only its Apple deliveries failed", async () => {
    // The Google class message already went out before any Apple delivery exists.
    const world = buildWorld({
      type: NotificationType.BROADCAST,
      notificationStatus: NotificationStatus.SENT
    });

    await serviceFor(world.prisma, async () => {
      throw new Error("x");
    }).processDelivery("delivery-apple");

    expect(world.state.notificationStatus).toBe(NotificationStatus.PARTIAL_FAILED);
    // Already counted when the class message went out.
    expect(world.state.clinicIncrements).toBe(0);
  });
});

describe("the text a later message puts on the pass", () => {
  it("differs between two days even for the same header and body", () => {
    const words = { header: "Título", body: "cuerpo" };
    const monday = formatCardMessage({ ...words, sentAt: new Date("2026-10-26T10:00:00Z") });
    const tuesday = formatCardMessage({ ...words, sentAt: new Date("2026-10-27T10:00:00Z") });

    expect(monday).toBe("26 oct · Título: cuerpo");
    expect(tuesday).toBe("27 oct · Título: cuerpo");
    expect(monday).not.toBe(tuesday);
  });
});

const actor = { role: "VOONE_ADMIN", permissions: [PERMISSIONS.notificationsSend] };

describe("which deliveries each kind of message creates", () => {
  it("a segment message adds an APPLE delivery for members with a synced Apple object", async () => {
    let created: Array<{ memberId: string; provider: WalletProviderType }> = [];
    const service = new NotificationService(
      {
        clinicNotificationSettings: { upsert: async () => ({ marketingEnabled: true }) },
        member: {
          findMany: async () => [
            { id: "m-google", createdAt: new Date(), pointsLedger: [] },
            { id: "m-apple", createdAt: new Date(), pointsLedger: [] }
          ]
        },
        walletObject: {
          findMany: async () => [{ memberId: "m-apple" }]
        },
        notification: {
          findFirst: async () => null,
          create: async ({ data }: { data: { deliveries: { create: typeof created } } }) => {
            created = data.deliveries.create;
            return { id: "n-1" };
          }
        },
        notificationAuditLog: { create: async () => undefined },
        notificationDelivery: { findMany: async () => [{ id: "d-1" }] }
      } as never,
      {} as never,
      {} as never,
      { enqueueDelivery: async () => undefined } as never
    );

    await service.segment("clinic-1", { header: "H", body: "B", notify: true, segment: {} }, actor);

    expect(created).toEqual([
      expect.objectContaining({ memberId: "m-google", provider: WalletProviderType.GOOGLE }),
      expect.objectContaining({ memberId: "m-apple", provider: WalletProviderType.GOOGLE }),
      expect.objectContaining({ memberId: "m-apple", provider: WalletProviderType.APPLE })
    ]);
  });

  it("a single message adds an APPLE delivery when the member has a synced Apple object", async () => {
    const run = async (hasApple: boolean) => {
      let created: Array<{ provider: WalletProviderType }> = [];
      const service = new NotificationService(
        {
          member: { findFirst: async () => ({ id: "m-1", clinicId: "clinic-1" }) },
          clinicNotificationSettings: { upsert: async () => ({ marketingEnabled: true }) },
          walletObject: { findMany: async () => (hasApple ? [{ memberId: "m-1" }] : []) },
          notification: {
            findFirst: async () => null,
            create: async ({ data }: { data: { deliveries: { create: typeof created } } }) => {
              created = data.deliveries.create;
              return { id: "n-1", deliveries: created.map((_, i) => ({ id: `d-${i}` })) };
            }
          },
          notificationAuditLog: { create: async () => undefined }
        } as never,
        {} as never,
        {} as never,
        { enqueueDelivery: async () => undefined } as never
      );

      await service.single("m-1", { header: "H", body: "B", notify: true }, actor);

      return created.map((delivery) => delivery.provider);
    };

    expect(await run(true)).toEqual([WalletProviderType.GOOGLE, WalletProviderType.APPLE]);
    expect(await run(false)).toEqual([WalletProviderType.GOOGLE]);
  });

  it("a broadcast fans out one APPLE delivery job per member with a synced Apple object, after the Google class message", async () => {
    const order: string[] = [];
    const createdMembers: string[] = [];
    const enqueued: string[] = [];
    const notification = {
      id: "n-1",
      clinicId: "clinic-1",
      type: NotificationType.BROADCAST,
      status: NotificationStatus.QUEUED,
      header: "H",
      body: "B",
      actionUrl: null,
      notify: true
    };
    const service = new NotificationService(
      {
        notification: {
          findUnique: async () => notification,
          update: async () => undefined
        },
        walletClass: { findFirst: async () => ({ externalClassId: "class-1" }) },
        clinic: { update: async () => undefined },
        walletObject: {
          findMany: async () => [{ memberId: "m-1" }, { memberId: "m-2" }, { memberId: "m-3" }]
        },
        notificationDelivery: {
          findMany: async (args: { where: { status?: NotificationDeliveryStatus } }) =>
            args.where.status === NotificationDeliveryStatus.QUEUED
              ? [{ id: "d-1" }, { id: "d-2" }, { id: "d-3" }]
              : [{ memberId: "m-2", provider: WalletProviderType.APPLE }],
          createMany: async ({ data }: { data: Array<{ memberId: string }> }) => {
            order.push("createMany");
            createdMembers.push(...data.map((row) => row.memberId));
          }
        }
      } as never,
      {
        addClassMessage: async () => {
          order.push("google");
          return { messageId: "msg-1" };
        }
      } as never,
      {} as never,
      {
        enqueueDelivery: async (id: string) => {
          order.push("enqueue");
          enqueued.push(id);
        }
      } as never
    );

    await service.processNotification("n-1");

    expect(order[0]).toBe("google");
    // m-2 already has a delivery (a retry): only the missing ones are created.
    expect(createdMembers).toEqual(["m-1", "m-3"]);
    expect(enqueued).toEqual(["d-1", "d-2", "d-3"]);
  });
});

describe("counts for a broadcast", () => {
  const countsFor = async (status: NotificationStatus, failedDeliveries: number) => {
    const service = new NotificationService(
      {
        notification: {
          findUnique: async () => ({
            id: "n-1",
            clinicId: "clinic-1",
            type: NotificationType.BROADCAST,
            status
          })
        },
        member: { count: async () => 10 },
        notificationDelivery: {
          count: async () => failedDeliveries
        }
      } as never,
      {} as never,
      {} as never,
      {} as never
    );

    return (await service.get("n-1", actor)).counts;
  };

  it("reports the failed Apple deliveries of a partially failed broadcast", async () => {
    expect(await countsFor(NotificationStatus.PARTIAL_FAILED, 3)).toEqual({
      total: 10,
      sent: 7,
      downgraded: 0,
      failed: 3,
      skipped: 0
    });
  });

  it("keeps the sent broadcast figures as they were", async () => {
    expect(await countsFor(NotificationStatus.SENT, 0)).toEqual({
      total: 10,
      sent: 10,
      downgraded: 0,
      failed: 0,
      skipped: 0
    });
  });
});
