import { NotificationDeliveryStatus, WalletProviderType, WalletSyncStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { NotificationService } from "../../src/modules/notifications/notification.service";

const queuedDelivery = {
  id: "delivery-1",
  notificationId: "notification-1",
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