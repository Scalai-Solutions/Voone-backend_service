import { NotificationDeliveryStatus, WalletProviderType, WalletSyncStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "../../src/modules/auth/rbac";
import { NotificationService } from "../../src/modules/notifications/notification.service";

const queuedDelivery = {
  id: "delivery-1",
  notificationId: "notification-1",
  provider: WalletProviderType.GOOGLE,
  status: NotificationDeliveryStatus.QUEUED,
  notification: {
    id: "notification-1",
    clinicId: "clinic-1",
    header: "Hello",
    body: "Come in",
    actionUrl: "https://example.com/book",
    notify: true,
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
};

describe("NotificationService", () => {
  describe("points credit", () => {
    const creditedPoints = async (
      programmeCentre: boolean,
      balances: { job: number; current: number } = { job: 120, current: 120 }
    ) => {
      const patches: Array<{ points: number }> = [];
      const bodies: string[] = [];
      const headers: string[] = [];
      const prisma = {
        member: {
          findFirst: async () => ({
            id: "member-1",
            clinicId: "clinic-1",
            tier: null,
            pointsBalance: balances.current,
            walletObjects: [
              {
                provider: WalletProviderType.GOOGLE,
                status: WalletSyncStatus.SYNCED,
                externalObjectId: "issuer.member_1"
              }
            ]
          })
        },
        onboardingProgram: { count: async () => (programmeCentre ? 1 : 0) },
        clinicNotificationSettings: { upsert: async () => ({ notifyOnCredit: "NEVER" }) },
        notification: {
          create: async ({ data }: { data: { header: string; body: string } }) => {
            headers.push(data.header);
            bodies.push(data.body);
            return {
              id: "notification-1",
              clinicId: "clinic-1",
              type: "POINTS",
              status: "QUEUED",
              deliveries: [{ id: "delivery-1" }]
            };
          },
          update: async () => undefined,
          updateMany: async () => ({ count: 1 })
        },
        notificationDelivery: {
          update: async () => undefined,
          findMany: async () => [{ status: NotificationDeliveryStatus.SENT }]
        }
      };
      const service = new NotificationService(
        prisma as never,
        {
          patchPoints: async (_objectId: string, patch: { points: number }) => {
            patches.push(patch);
          }
        } as never,
        { canPush: async () => false, recordPush: async () => undefined } as never,
        {} as never
      );

      await service.processPointsCredit({
        memberId: "member-1",
        newBalance: balances.job,
        milestoneReached: false,
        tierChanged: false
      });

      return { points: patches.map((patch) => patch.points), bodies, headers };
    };

    it("sends a programme centre's balance to Google in points, ten per euro", async () => {
      expect(await creditedPoints(true)).toEqual({
        points: [1200],
        bodies: ["Tu saldo ahora es 1200"],
        headers: ["Puntos actualizados"]
      });
    });

    it("pushes the member's CURRENT balance, so a delayed job cannot send an older number", async () => {
      // The job was queued at 120 (12 euros) but a later credit has since made it 150.
      expect(await creditedPoints(true, { job: 120, current: 150 })).toEqual({
        points: [1500],
        bodies: ["Tu saldo ahora es 1500"],
        headers: ["Puntos actualizados"]
      });
      expect(await creditedPoints(false, { job: 120, current: 150 })).toMatchObject({
        points: [150],
        bodies: ["Tu saldo ahora es 150"]
      });
    });

    it("leaves every other centre's balance as the ledger holds it", async () => {
      expect(await creditedPoints(false)).toEqual({
        points: [120],
        bodies: ["Tu saldo ahora es 120"],
        headers: ["Puntos actualizados"]
      });
    });
  });

  it("downgrades a marketing object message when reserved quota would be consumed", async () => {
    const walletCalls: unknown[] = [];
    let deliveryStatus: NotificationDeliveryStatus = NotificationDeliveryStatus.QUEUED;
    const prisma = {
      notificationDelivery: {
        findUnique: async () => queuedDelivery,
        update: async ({ data }: { data: { status: NotificationDeliveryStatus } }) => {
          deliveryStatus = data.status;
        },
        findMany: async () => [{ status: deliveryStatus }]
      },
      notification: { update: async () => undefined, updateMany: async () => ({ count: 1 }) }
    };
    const service = new NotificationService(
      prisma as never,
      {
        addObjectMessage: async (_objectId: string, message: unknown) => {
          walletCalls.push(message);
          return { messageId: "message-1" };
        }
      } as never,
      { canMarketingPush: async () => false, recordPush: async () => undefined } as never,
      {} as never
    );

    await service.processDelivery("delivery-1");

    expect(deliveryStatus).toBe(NotificationDeliveryStatus.DOWNGRADED);
    expect(walletCalls).toEqual([
      {
        header: "Hello",
        body: "Come in\nhttps://example.com/book",
        notify: false,
        actionUrl: "https://example.com/book"
      }
    ]);
  });

  it("requires explicit notification permission for staff readers", async () => {
    let queried = false;
    const service = new NotificationService(
      {
        notification: {
          findMany: async () => {
            queried = true;
            return [];
          }
        }
      } as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(
      service.list("clinic-1", {}, { role: "STAFF", clinicId: "clinic-1" })
    ).rejects.toThrow("Notifications permission is required");
    expect(queried).toBe(false);

    await expect(
      service.list(
        "clinic-1",
        {},
        {
          role: "STAFF",
          clinicId: "clinic-1",
          permissions: [PERMISSIONS.notificationsSend]
        }
      )
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(queried).toBe(true);
  });

  it("skips an Apple delivery for a member with no synced Apple pass", async () => {
    let deliveryStatus: NotificationDeliveryStatus = NotificationDeliveryStatus.QUEUED;
    let errorCode: string | null | undefined;
    const service = new NotificationService(
      {
        notificationDelivery: {
          findUnique: async () => ({
            ...queuedDelivery,
            provider: WalletProviderType.APPLE,
            member: { walletObjects: [] }
          }),
          update: async ({
            data
          }: {
            data: { status: NotificationDeliveryStatus; errorCode?: string | null };
          }) => {
            deliveryStatus = data.status;
            errorCode = data.errorCode;
          },
          findMany: async () => [{ status: deliveryStatus }]
        },
        notification: { update: async () => undefined, updateMany: async () => ({ count: 1 }) }
      } as never,
      { addObjectMessage: async () => ({ messageId: "should-not-run" }) } as never,
      { canMarketingPush: async () => true, recordPush: async () => undefined } as never,
      {} as never
    );

    await service.processDelivery("delivery-apple");

    expect(deliveryStatus).toBe(NotificationDeliveryStatus.SKIPPED);
    expect(errorCode).toBe("NO_APPLE_PASS");
  });

  it("creates birthday notifications for members with synced wallet passes", async () => {
    const enqueued: string[] = [];
    const settings = {
      marketingEnabled: true,
      birthdayEnabled: true,
      birthdayLastRunDate: null,
      birthdayHeader: "¡Feliz cumpleaños!",
      birthdayBody: "Disfruta de un 10% de descuento.",
      birthdayNotify: true
    };
    const service = new NotificationService(
      {
        clinic: {
          findMany: async () => [
            {
              id: "clinic-1",
              isActive: true,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              notificationSettings: settings
            }
          ]
        },
        member: {
          findMany: async () => [
            {
              id: "member-1",
              birthDate: new Date("1990-10-17T00:00:00.000Z"),
              walletObjects: [
                {
                  provider: WalletProviderType.GOOGLE,
                  status: WalletSyncStatus.SYNCED
                },
                {
                  provider: WalletProviderType.APPLE,
                  status: WalletSyncStatus.SYNCED
                }
              ]
            },
            {
              id: "member-2",
              birthDate: new Date("1990-10-18T00:00:00.000Z"),
              walletObjects: [
                {
                  provider: WalletProviderType.GOOGLE,
                  status: WalletSyncStatus.SYNCED
                }
              ]
            }
          ]
        },
        notification: {
          findFirst: async () => null,
          create: async ({
            data
          }: {
            data: {
              deliveries: { create: Array<{ memberId: string; provider: WalletProviderType }> };
            };
          }) => ({
            id: "notification-birthday",
            deliveries: data.deliveries.create.map((_, index) => ({ id: `delivery-${index + 1}` }))
          })
        },
        notificationAuditLog: { create: async () => undefined },
        clinicNotificationSettings: { update: async () => undefined }
      } as never,
      {} as never,
      {} as never,
      { enqueueDelivery: async (deliveryId: string) => enqueued.push(deliveryId) } as never
    );

    const result = await service.runBirthdayAutomations(new Date("2026-10-17T07:05:00.000Z"));

    expect(result).toMatchObject({
      date: "2026-10-17",
      clinicsChecked: 1,
      candidates: 1,
      notificationsCreated: 1,
      deliveriesCreated: 2
    });
    expect(enqueued).toEqual(["delivery-1", "delivery-2"]);
  });

  it("resolves tier and inactivity segment filters inside the clinic", async () => {
    const oldVisit = new Date("2026-01-01T00:00:00.000Z");
    const recentVisit = new Date();
    const service = new NotificationService(
      {
        member: {
          findMany: async () => [
            {
              id: "member-old-silver",
              tier: "Silver",
              createdAt: oldVisit,
              pointsLedger: [{ createdAt: oldVisit, reason: null, sourceRef: null }]
            },
            {
              id: "member-recent-silver",
              tier: "Silver",
              createdAt: recentVisit,
              pointsLedger: [{ createdAt: recentVisit, reason: null, sourceRef: null }]
            }
          ]
        }
      } as never,
      {} as never,
      {} as never,
      {} as never
    );

    const members = await service.resolveSegment("clinic-1", { tier: "Silver", inactiveDays: 30 });

    expect(members.map((member) => member.id)).toEqual(["member-old-silver"]);
  });
});

describe("bono reminder automation", () => {
  const settings = {
    bonoReminderEnabled: true,
    bonoReminderHeader: "Sesiones pendientes",
    bonoReminderBody: "Te quedan sesiones de tu bono.",
    bonoReminderNotify: true
  };

  const build = (overrides: {
    day?: Date;
    existing?: unknown;
    members?: unknown[];
    settings?: Record<string, unknown>;
    notificationCreate?: (data: unknown) => unknown;
  }) => {
    const enqueued: string[] = [];
    const created: unknown[] = [];

    const service = new NotificationService(
      {
        clinic: {
          findMany: async () => [
            {
              id: "clinic-1",
              isActive: true,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              notificationSettings: { ...settings, ...(overrides.settings ?? {}) }
            }
          ]
        },
        member: {
          findMany: async () =>
            overrides.members ?? [
              {
                // No consentMarketing field at all: the reminder is deliberately not
                // gated on consent, and this member must still be a candidate.
                id: "member-1",
                walletObjects: [
                  { provider: WalletProviderType.GOOGLE, status: WalletSyncStatus.SYNCED }
                ]
              },
              {
                id: "member-2",
                walletObjects: [
                  { provider: WalletProviderType.GOOGLE, status: WalletSyncStatus.PENDING }
                ]
              }
            ]
        },
        notification: {
          findFirst: async () => overrides.existing ?? null,
          create: async ({ data }: { data: unknown }) => {
            created.push(data);

            return {
              id: "notification-bono",
              deliveries: [{ id: "delivery-1" }, { id: "delivery-2" }]
            };
          }
        },
        notificationDelivery: {
          findMany: async () => [
            { id: "delivery-0", memberId: "member-1", provider: "GOOGLE", status: "SENT" }
          ],
          create: async () => ({ id: "delivery-created" })
        },
        notificationAuditLog: { create: async () => undefined },
        clinicNotificationSettings: { update: async () => undefined }
      } as never,
      {} as never,
      {} as never,
      { enqueueDelivery: async (deliveryId: string) => enqueued.push(deliveryId) } as never
    );

    return { service, enqueued, created };
  };

  it("sends on the 1st to members with an active bono and a synced pass", async () => {
    const { service, enqueued, created } = build({});

    const result = await service.runBonoReminderAutomations(new Date("2026-11-01T08:05:00.000Z"));

    expect(result).toMatchObject({
      month: "2026-11",
      clinicsChecked: 1,
      candidates: 1,
      notificationsCreated: 1,
      deliveriesCreated: 2
    });
    expect(enqueued).toEqual(["delivery-1", "delivery-2"]);
    expect(created[0]).toMatchObject({
      clinicId: "clinic-1",
      type: "BONO_REMINDER",
      header: "Sesiones pendientes",
      segmentJson: { automation: "bono_reminder", month: "2026-11" }
    });
  });

  it("does nothing on any other day of the month", async () => {
    const { service, enqueued, created } = build({});

    const result = await service.runBonoReminderAutomations(new Date("2026-11-02T08:05:00.000Z"));

    expect(result).toEqual({
      month: "2026-11",
      clinicsChecked: 0,
      candidates: 0,
      notificationsCreated: 0,
      deliveriesCreated: 0
    });
    expect(enqueued).toEqual([]);
    expect(created).toEqual([]);
  });

  it("skips a clinic that turned the reminder off", async () => {
    const { service, created } = build({ settings: { bonoReminderEnabled: false } });

    const result = await service.runBonoReminderAutomations(new Date("2026-11-01T08:05:00.000Z"));

    expect(result.notificationsCreated).toBe(0);
    expect(created).toEqual([]);
  });

  it("does not create a second notification for the same month", async () => {
    const { service, created } = build({ existing: { id: "notification-bono" } });

    const result = await service.runBonoReminderAutomations(new Date("2026-11-01T08:05:00.000Z"));

    expect(result.notificationsCreated).toBe(0);
    expect(created).toEqual([]);
    // The already-sent delivery is not re-queued; only what is missing is created.
    expect(result.deliveriesCreated).toBe(0);
  });

  it("resolves the active-bono segment by the relation the schema names", async () => {
    const wheres: unknown[] = [];
    const service = new NotificationService(
      {
        member: {
          findMany: async ({ where }: { where: unknown }) => {
            wheres.push(where);

            return [{ id: "member-1", pointsLedger: [] }];
          }
        }
      } as never,
      {} as never,
      {} as never,
      {} as never
    );

    const members = await service.resolveSegment("clinic-1", { activeBono: true });

    expect(members.map((member) => member.id)).toEqual(["member-1"]);
    expect(wheres[0]).toMatchObject({ bonos: { some: { status: "ACTIVE" } } });
  });
});
