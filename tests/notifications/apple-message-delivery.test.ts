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
  /** The Google class message already went out (a broadcast with a Google class). */
  googleSent?: boolean;
  createdAt?: Date;
  /** What MemberWalletMessage already holds for the member. */
  stored?: { notificationId: string | null; sentAt: Date };
  /** Creation time of the notification the stored message came from. */
  storedNotificationCreatedAt?: Date;
}

/** An in-memory stand-in for the handful of tables processDelivery touches, with an event log. */
const buildWorld = (world: World = {}) => {
  const log: string[] = [];
  const state = {
    deliveryStatus: NotificationDeliveryStatus.QUEUED as Status,
    errorCode: undefined as string | null | undefined,
    messages: [] as Array<{ memberId: string; header: string; body: string; sentAt: Date }>,
    clinicIncrements: 0,
    notificationStatus: (world.notificationStatus ??
      NotificationStatus.QUEUED) as NotificationStatus
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
      createdAt: world.createdAt ?? new Date("2026-10-27T09:00:00Z"),
      providerMessageId: world.googleSent ? "google-msg" : null,
      // A snapshot, as processDelivery reads it: it never follows later status writes.
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
      findUnique: async () => world.stored ?? null,
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
      findUnique: async () => ({
        createdAt: world.storedNotificationCreatedAt ?? new Date("2026-10-01T00:00:00Z")
      }),
      update: async ({ data }: { data: { status?: NotificationStatus } }) => {
        if (data.status) state.notificationStatus = data.status;
      },
      // Models the conditional write atomically: check and set in one synchronous step.
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

  it("counts a notification once, when it first reaches SENT, as before", async () => {
    const sent = buildWorld();

    await serviceFor(sent.prisma, async () => undefined).processDelivery("delivery-apple");

    expect(sent.state.notificationStatus).toBe(NotificationStatus.SENT);
    expect(sent.state.clinicIncrements).toBe(1);

    // Unchanged Google-era rule: an all-skipped notification still ends SENT and is counted.
    const skipped = buildWorld({ walletObjects: [] });

    await serviceFor(skipped.prisma, async () => undefined).processDelivery("delivery-apple");

    expect(skipped.state.notificationStatus).toBe(NotificationStatus.SENT);
    expect(skipped.state.clinicIncrements).toBe(1);
  });

  it("marks an Apple-only broadcast whose deliveries all failed FAILED, not partial", async () => {
    const world = buildWorld({
      type: NotificationType.BROADCAST,
      notificationStatus: NotificationStatus.PROCESSING
    });

    await serviceFor(world.prisma, async () => {
      throw new Error("x");
    }).processDelivery("delivery-apple");

    expect(world.state.notificationStatus).toBe(NotificationStatus.FAILED);
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
      notificationStatus: NotificationStatus.SENT,
      googleSent: true
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

describe("retrying a broadcast whose class message already went out", () => {
  it.each([NotificationStatus.SENT, NotificationStatus.PARTIAL_FAILED])(
    "does not send the Google class message again when the broadcast is %s, and still fans out",
    async (status) => {
      let googleSends = 0;
      let created = 0;
      const service = new NotificationService(
        {
          notification: {
            findUnique: async () => ({
              id: "n-1",
              clinicId: "clinic-1",
              type: NotificationType.BROADCAST,
              status,
              header: "H",
              body: "B",
              actionUrl: null,
              notify: true
            }),
            update: async () => undefined
          },
          walletClass: { findFirst: async () => ({ externalClassId: "class-1" }) },
          clinic: {
            update: async () => {
              throw new Error("must not be counted again");
            }
          },
          walletObject: { findMany: async () => [{ memberId: "m-1" }] },
          notificationDelivery: {
            findMany: async () => [],
            createMany: async () => {
              created += 1;
            }
          }
        } as never,
        {
          addClassMessage: async () => {
            googleSends += 1;
            return { messageId: "msg" };
          }
        } as never,
        {} as never,
        { enqueueDelivery: async () => undefined } as never
      );

      await service.processNotification("n-1");

      expect(googleSends).toBe(0);
      expect(created).toBe(1);
    }
  );
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
            status,
            providerMessageId: "google-msg"
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

describe("guards on the stored Apple message", () => {
  const stamp = new Date("2026-10-20T08:00:00Z");

  it("keeps the original message and date when the same notification is reprocessed, but still refreshes and marks SENT", async () => {
    const { prisma, log, state } = buildWorld({
      stored: { notificationId: "notification-1", sentAt: stamp }
    });
    let refreshes = 0;

    await serviceFor(prisma, async () => {
      refreshes += 1;
    }).processDelivery("delivery-apple");

    expect(log).toEqual(["mark:SENT"]);
    expect(refreshes).toBe(1);
    expect(state.messages).toHaveLength(0);
  });

  it("does not let an older notification overwrite a newer message: SKIPPED SUPERSEDED_BY_NEWER_MESSAGE", async () => {
    const { prisma, log, state } = buildWorld({
      createdAt: new Date("2026-10-27T09:00:00Z"),
      stored: { notificationId: "notification-newer", sentAt: stamp },
      storedNotificationCreatedAt: new Date("2026-10-27T10:00:00Z")
    });
    let refreshes = 0;

    await serviceFor(prisma, async () => {
      refreshes += 1;
    }).processDelivery("delivery-apple");

    expect(log).toEqual(["mark:SKIPPED"]);
    expect(state.errorCode).toBe("SUPERSEDED_BY_NEWER_MESSAGE");
    expect(state.messages).toHaveLength(0);
    expect(refreshes).toBe(0);
  });

  it("overwrites a message that came from an older notification", async () => {
    const { prisma, log, state } = buildWorld({
      createdAt: new Date("2026-10-27T09:00:00Z"),
      stored: { notificationId: "notification-older", sentAt: stamp },
      storedNotificationCreatedAt: new Date("2026-10-26T10:00:00Z")
    });

    await serviceFor(prisma, async () => undefined).processDelivery("delivery-apple");

    expect(log).toEqual(["upsert", "mark:SENT"]);
    expect(state.messages).toHaveLength(1);
  });

  it("overwrites a message whose notification no longer exists", async () => {
    const { prisma, log } = buildWorld({
      stored: { notificationId: "notification-gone", sentAt: stamp }
    });

    (prisma.notification as { findUnique: () => Promise<unknown> }).findUnique = async () => null;
    await serviceFor(prisma, async () => undefined).processDelivery("delivery-apple");

    expect(log).toEqual(["upsert", "mark:SENT"]);
  });
});

describe("two deliveries of one notification finishing together", () => {
  it("increments the monthly figure exactly once", async () => {
    const statuses: Record<string, NotificationDeliveryStatus> = {
      "d-google": NotificationDeliveryStatus.QUEUED,
      "d-apple": NotificationDeliveryStatus.QUEUED
    };
    let notificationStatus: NotificationStatus = NotificationStatus.QUEUED;
    let increments = 0;
    const snapshot = {
      id: "n-1",
      clinicId: "clinic-1",
      type: NotificationType.SINGLE,
      header: "H",
      body: "B",
      actionUrl: null,
      notify: false,
      createdAt: new Date("2026-10-27T09:00:00Z"),
      providerMessageId: null,
      // Both jobs read the notification while it is still QUEUED.
      status: NotificationStatus.QUEUED
    };
    const deliveryFor = (id: string, provider: WalletProviderType) => ({
      id,
      notificationId: "n-1",
      memberId: "m-1",
      provider,
      status: NotificationDeliveryStatus.QUEUED,
      notification: snapshot,
      member: {
        walletObjects: [
          { provider, status: WalletSyncStatus.SYNCED, externalObjectId: `obj-${provider}` }
        ]
      }
    });
    const deliveries: Record<string, ReturnType<typeof deliveryFor>> = {
      "d-google": deliveryFor("d-google", WalletProviderType.GOOGLE),
      "d-apple": deliveryFor("d-apple", WalletProviderType.APPLE)
    };
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const prisma = {
      notificationDelivery: {
        findUnique: async ({ where }: { where: { id: string } }) => deliveries[where.id],
        update: async ({
          where,
          data
        }: {
          where: { id: string };
          data: { status: NotificationDeliveryStatus };
        }) => {
          await tick();
          statuses[where.id] = data.status;
        },
        findMany: async () => {
          // Hold every reader until both deliveries are written, so both see zero QUEUED:
          // the interleaving that double-counted.
          for (let i = 0; i < 50 && Object.values(statuses).includes("QUEUED"); i += 1) {
            await tick();
          }
          return Object.values(statuses).map((status) => ({ status }));
        }
      },
      memberWalletMessage: { findUnique: async () => null, upsert: async () => undefined },
      notification: {
        update: async ({ data }: { data: { status: NotificationStatus } }) => {
          notificationStatus = data.status;
        },
        updateMany: async ({
          where,
          data
        }: {
          where: { status: { notIn?: NotificationStatus[]; in?: NotificationStatus[] } };
          data: { status: NotificationStatus };
        }) => {
          await tick();
          if (where.status.notIn?.includes(notificationStatus)) return { count: 0 };
          if (where.status.in && !where.status.in.includes(notificationStatus)) {
            return { count: 0 };
          }
          notificationStatus = data.status;
          return { count: 1 };
        }
      },
      clinic: {
        update: async () => {
          increments += 1;
        }
      }
    };
    const service = serviceFor(
      prisma,
      async () => {
        await tick();
      },
      quotaSpy().quota,
      { addObjectMessage: async () => ({ messageId: "g-1" }) }
    );

    await Promise.all([service.processDelivery("d-google"), service.processDelivery("d-apple")]);

    expect(notificationStatus).toBe(NotificationStatus.SENT);
    expect(increments).toBe(1);
  });
});

describe("a broadcast from a clinic with no Google class", () => {
  const baseNotification = {
    id: "n-1",
    clinicId: "clinic-1",
    type: NotificationType.BROADCAST,
    status: NotificationStatus.QUEUED,
    header: "H",
    body: "B",
    actionUrl: null,
    notify: true,
    providerMessageId: null
  };

  it.each([
    ["has no Google class", null],
    ["has a Google class", { externalClassId: "class-1" }]
  ])("creates the notification and queues it when the clinic %s", async (_label, googleClass) => {
    const enqueued: string[] = [];
    const service = new NotificationService(
      {
        clinicNotificationSettings: { upsert: async () => ({ marketingEnabled: true }) },
        notification: {
          count: async () => 0,
          findFirst: async () => null,
          create: async () => ({ id: "n-1" })
        },
        walletClass: { findFirst: async () => googleClass },
        member: { count: async () => 4 },
        notificationAuditLog: { create: async () => undefined }
      } as never,
      {} as never,
      {} as never,
      { enqueueNotification: async (id: string) => enqueued.push(id) } as never
    );

    await service.broadcast("clinic-1", { header: "H", body: "B", notify: true }, actor);

    expect(enqueued).toEqual(["n-1"]);
  });

  const apple = (members: string[]) => {
    const updates: Array<{ status?: NotificationStatus }> = [];
    const created: string[] = [];
    const enqueuedDeliveries: string[] = [];
    let googleSends = 0;
    let notificationStatus: NotificationStatus = NotificationStatus.QUEUED;
    const service = new NotificationService(
      {
        notification: {
          findUnique: async () => ({ ...baseNotification, status: notificationStatus }),
          update: async ({ data }: { data: { status?: NotificationStatus } }) => {
            updates.push(data);
            if (data.status) notificationStatus = data.status;
          },
          updateMany: async ({ data }: { data: { status?: NotificationStatus } }) => {
            updates.push(data);
            if (data.status) notificationStatus = data.status;
            return { count: 1 };
          }
        },
        walletClass: { findFirst: async () => null },
        clinic: {
          update: async () => {
            throw new Error("nothing was sent, nothing to count here");
          }
        },
        walletObject: { findMany: async () => members.map((memberId) => ({ memberId })) },
        notificationDelivery: {
          findMany: async (args: { where: { status?: NotificationDeliveryStatus } }) =>
            args.where.status === NotificationDeliveryStatus.QUEUED
              ? created.map((memberId) => ({ id: `d-${memberId}` }))
              : args.where.status === undefined && "provider" in args.where
                ? []
                : [],
          createMany: async ({ data }: { data: Array<{ memberId: string }> }) => {
            created.push(...data.map((row) => row.memberId));
          }
        }
      } as never,
      {
        addClassMessage: async () => {
          googleSends += 1;
          return { messageId: "x" };
        }
      } as never,
      {} as never,
      { enqueueDelivery: async (id: string) => enqueuedDeliveries.push(id) } as never
    );

    return { service, updates, created, enqueuedDeliveries, googleSends: () => googleSends };
  };

  it("skips the Google class message and still fans out the Apple deliveries", async () => {
    const run = apple(["m-1", "m-2"]);

    await run.service.processNotification("n-1");

    expect(run.googleSends()).toBe(0);
    expect(run.created).toEqual(["m-1", "m-2"]);
    expect(run.enqueuedDeliveries).toEqual(["d-m-1", "d-m-2"]);
    // Left PROCESSING: the deliveries finish it, and count it, as they complete.
    expect(run.updates).toEqual([{ status: NotificationStatus.PROCESSING }]);
  });

  it("finishes straight away, without throwing, when it has no Apple recipients either", async () => {
    const run = apple([]);

    await expect(run.service.processNotification("n-1")).resolves.toBeUndefined();

    expect(run.googleSends()).toBe(0);
    expect(run.updates.at(-1)).toEqual({ status: NotificationStatus.SENT });
  });
});

describe("counts for an Apple-only broadcast", () => {
  it("come from its deliveries, not from the clinic's member count", async () => {
    const service = new NotificationService(
      {
        notification: {
          findUnique: async () => ({
            id: "n-1",
            clinicId: "clinic-1",
            type: NotificationType.BROADCAST,
            status: NotificationStatus.SENT,
            providerMessageId: null
          })
        },
        member: { count: async () => 100 },
        notificationDelivery: {
          groupBy: async () => [
            { status: NotificationDeliveryStatus.SENT, _count: { _all: 3 } },
            { status: NotificationDeliveryStatus.SKIPPED, _count: { _all: 1 } }
          ]
        }
      } as never,
      {} as never,
      {} as never,
      {} as never
    );

    expect((await service.get("n-1", actor)).counts).toEqual({
      total: 4,
      sent: 3,
      downgraded: 0,
      failed: 0,
      skipped: 1
    });
  });
});
