import { NotificationDeliveryStatus, WalletProviderType, WalletSyncStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "../../src/modules/auth/rbac";
import {
  memberAge,
  NotificationService
} from "../../src/modules/notifications/notification.service";

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

describe("active-bono segment", () => {
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

describe("member-field segments", () => {
  const born = (date: string) => new Date(`${date}T00:00:00Z`);
  const today = { dateKey: "2026-11-04", year: 2026, month: 11, day: 4 };

  it("counts age in whole years, the day of the birthday included", () => {
    expect(memberAge({ birthDate: born("1990-11-04"), birthYear: null }, today)).toBe(36);
    expect(memberAge({ birthDate: born("1990-11-05"), birthYear: null }, today)).toBe(35);
    expect(memberAge({ birthDate: null, birthYear: 1990 }, today)).toBe(36);
    expect(memberAge({ birthDate: null, birthYear: null }, today)).toBeNull();
  });

  it("filters by sex and sign-up in the query, and by age and birthday month after it", async () => {
    const wheres: unknown[] = [];
    const thisYear = new Date().getUTCFullYear();
    const member = (id: string, birthDate: Date | null, birthYear: number | null = null) => ({
      id,
      birthDate,
      birthYear,
      createdAt: new Date(),
      pointsLedger: []
    });
    const service = new NotificationService(
      {
        member: {
          findMany: async ({ where }: { where: unknown }) => {
            wheres.push(where);

            return [
              member("thirty-march", born(`${thisYear - 31}-03-01`)),
              member("thirty-july", born(`${thisYear - 31}-07-01`)),
              member("sixty-march", born(`${thisYear - 61}-03-01`)),
              // A birth year alone has no month to match.
              member("year-only", null, thisYear - 31),
              member("unknown", null)
            ];
          }
        }
      } as never,
      {} as never,
      {} as never,
      {} as never
    );
    const joinedAfter = new Date("2026-01-01T00:00:00Z");

    const members = await service.resolveSegment("clinic-1", {
      sex: "mujer",
      ageMin: 25,
      ageMax: 40,
      birthMonth: 3,
      joinedAfter
    });

    expect(members.map((m) => m.id)).toEqual(["thirty-march"]);
    expect(wheres[0]).toMatchObject({ sex: "mujer", createdAt: { gte: joinedAfter } });
  });
});
