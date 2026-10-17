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
      notification: { update: async () => undefined }
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

  it("marks Apple notification deliveries as an explicit placeholder", async () => {
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
        notification: { update: async () => undefined }
      } as never,
      { addObjectMessage: async () => ({ messageId: "should-not-run" }) } as never,
      { canMarketingPush: async () => true, recordPush: async () => undefined } as never,
      {} as never
    );

    await service.processDelivery("delivery-apple");

    expect(deliveryStatus).toBe(NotificationDeliveryStatus.SKIPPED);
    expect(errorCode).toBe("APPLE_NOTIFICATION_PLACEHOLDER");
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
