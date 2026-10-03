import {
  ClinicNotifyOnCredit,
  NotificationDeliveryStatus,
  NotificationStatus,
  NotificationType,
  Prisma,
  WalletProviderType,
  WalletSyncStatus,
  type PrismaClient
} from "@prisma/client";

import {
  WalletNotificationNotFoundError,
  WalletNotificationQuotaExceededError,
  WalletNotificationTransientError
} from "../../common/errors/wallet.errors";
import type { WalletPassEngine } from "../../wallet/engine/wallet-pass.engine";
import {
  NotificationForbiddenError,
  NotificationNotFoundError,
  NotificationRateLimitError
} from "./notification.errors";
import type {
  ClinicLocationInput,
  NotificationMessageInput,
  NotificationSegmentInput,
  NotificationSettingsInput,
  SegmentNotificationInput
} from "./notifications.schema";
import { NotificationQuotaService } from "./quota.service";

const BROADCAST_LIMIT = 3;
const BROADCAST_WINDOW_MS = 24 * 60 * 60 * 1_000;
const PAGE_SIZE = 25;

export interface NotificationActor {
  userId?: string;
  clinicId?: string;
  role: string;
}

export interface PointsCreditNotificationJob {
  memberId: string;
  newBalance: number;
  milestoneReached: boolean;
  tierChanged: boolean;
}

export interface NotificationJobQueue {
  enqueueNotification(notificationId: string, delayMs?: number): Promise<void>;
  enqueueDelivery(deliveryId: string, delayMs?: number): Promise<void>;
  enqueuePointsCredit(job: PointsCreditNotificationJob): Promise<void>;
}

export interface NotificationCounts {
  total: number;
  sent: number;
  downgraded: number;
  failed: number;
  skipped: number;
}

type NotificationRecord = Awaited<ReturnType<NotificationService["findNotification"]>>;

export class NotificationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly wallet: WalletPassEngine,
    private readonly quota: NotificationQuotaService,
    private readonly jobs: NotificationJobQueue
  ) {}

  async broadcast(
    clinicId: string,
    input: NotificationMessageInput,
    actor: NotificationActor,
    idempotencyKey?: string
  ) {
    this.assertSender(actor, clinicId);

    const existing = await this.findIdempotent(clinicId, idempotencyKey);
    if (existing) return existing;

    await this.assertMarketingEnabled(clinicId);
    await this.assertBroadcastCapacity(clinicId);
    await this.googleClassForClinic(clinicId);

    const notification = await this.prisma.notification.create({
      data: {
        clinicId,
        type: NotificationType.BROADCAST,
        header: input.header,
        body: input.body,
        actionUrl: input.actionUrl,
        notify: input.notify,
        scheduledAt: input.scheduledAt,
        createdBy: actor.userId,
        idempotencyKey
      }
    });

    await this.audit(
      notification.id,
      clinicId,
      actor,
      "BROADCAST_CREATED",
      await this.memberCount(clinicId)
    );
    await this.jobs.enqueueNotification(notification.id, this.delayFor(input.scheduledAt));

    return notification;
  }

  async segment(
    clinicId: string,
    input: SegmentNotificationInput,
    actor: NotificationActor,
    idempotencyKey?: string
  ) {
    this.assertSender(actor, clinicId);

    const existing = await this.findIdempotent(clinicId, idempotencyKey);
    if (existing) return existing;

    await this.assertMarketingEnabled(clinicId);
    const members = await this.resolveSegment(clinicId, input.segment);

    const notification = await this.prisma.notification.create({
      data: {
        clinicId,
        type: NotificationType.SEGMENT,
        header: input.header,
        body: input.body,
        actionUrl: input.actionUrl,
        notify: input.notify,
        segmentJson: input.segment as Prisma.InputJsonValue,
        scheduledAt: input.scheduledAt,
        createdBy: actor.userId,
        idempotencyKey,
        deliveries: {
          create: members.map((member) => ({
            memberId: member.id,
            provider: WalletProviderType.GOOGLE,
            status: NotificationDeliveryStatus.QUEUED
          }))
        }
      }
    });

    await this.audit(
      notification.id,
      clinicId,
      actor,
      "SEGMENT_CREATED",
      members.length,
      input.segment
    );

    for (const chunk of this.chunks(members, 100)) {
      const deliveries = await this.prisma.notificationDelivery.findMany({
        where: {
          notificationId: notification.id,
          memberId: { in: chunk.map((member) => member.id) }
        },
        select: { id: true }
      });

      await Promise.all(
        deliveries.map((delivery) =>
          this.jobs.enqueueDelivery(delivery.id, this.delayFor(input.scheduledAt))
        )
      );
    }

    return notification;
  }

  async single(
    memberId: string,
    input: NotificationMessageInput,
    actor: NotificationActor,
    idempotencyKey?: string
  ) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, erasedAt: null },
      select: { id: true, clinicId: true }
    });

    if (!member) throw new NotificationNotFoundError("Member not found");

    this.assertSender(actor, member.clinicId);

    const existing = await this.findIdempotent(member.clinicId, idempotencyKey);
    if (existing) return existing;

    await this.assertMarketingEnabled(member.clinicId);

    const notification = await this.prisma.notification.create({
      data: {
        clinicId: member.clinicId,
        type: NotificationType.SINGLE,
        header: input.header,
        body: input.body,
        actionUrl: input.actionUrl,
        notify: input.notify,
        createdBy: actor.userId,
        idempotencyKey,
        deliveries: {
          create: {
            memberId: member.id,
            provider: WalletProviderType.GOOGLE,
            status: NotificationDeliveryStatus.QUEUED
          }
        }
      },
      include: { deliveries: { select: { id: true } } }
    });

    await this.audit(notification.id, member.clinicId, actor, "SINGLE_CREATED", 1);
    await this.jobs.enqueueDelivery(notification.deliveries[0].id);

    return notification;
  }

  async onPointsCredited(
    memberId: string,
    newBalance: number,
    flags: { milestoneReached: boolean; tierChanged: boolean }
  ): Promise<void> {
    await this.jobs.enqueuePointsCredit({ memberId, newBalance, ...flags });
  }

  async processNotification(notificationId: string): Promise<void> {
    const notification = await this.findNotification(notificationId);

    if (!notification) throw new NotificationNotFoundError();
    if (notification.status === NotificationStatus.CANCELLED) return;

    if (notification.type !== NotificationType.BROADCAST) return;

    const walletClass = await this.googleClassForClinic(notification.clinicId);

    await this.prisma.notification.update({
      where: { id: notification.id },
      data: { status: NotificationStatus.PROCESSING }
    });

    const message = await this.wallet.addClassMessage(walletClass.externalClassId, {
      header: notification.header,
      body: this.bodyWithAction(notification.body, notification.actionUrl),
      notify: notification.notify,
      actionUrl: notification.actionUrl ?? undefined
    });

    await this.prisma.notification.update({
      where: { id: notification.id },
      data: { status: NotificationStatus.SENT, providerMessageId: message.messageId }
    });

    console.info("[notifications] broadcast sent", {
      notificationId: notification.id,
      clinicId: notification.clinicId
    });
  }

  async processDelivery(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      include: { notification: true, member: { include: { walletObjects: true } } }
    });

    if (!delivery) throw new NotificationNotFoundError("Notification delivery not found");
    if (delivery.notification.status === NotificationStatus.CANCELLED) return;
    if (delivery.status !== NotificationDeliveryStatus.QUEUED) return;

    const object = delivery.member.walletObjects.find(
      (walletObject) =>
        walletObject.provider === WalletProviderType.GOOGLE &&
        walletObject.status === WalletSyncStatus.SYNCED
    );

    if (!object) {
      await this.markDelivery(delivery.id, NotificationDeliveryStatus.SKIPPED, "NO_GOOGLE_PASS");
      await this.refreshNotificationStatus(delivery.notificationId);
      return;
    }

    const wantsPush = delivery.notification.notify;
    const canPush = wantsPush ? await this.quota.canMarketingPush(object.externalObjectId) : false;
    const notify = wantsPush && canPush;
    const status =
      wantsPush && !notify
        ? NotificationDeliveryStatus.DOWNGRADED
        : NotificationDeliveryStatus.SENT;

    try {
      const message = await this.wallet.addObjectMessage(object.externalObjectId, {
        header: delivery.notification.header,
        body: this.bodyWithAction(delivery.notification.body, delivery.notification.actionUrl),
        notify,
        actionUrl: delivery.notification.actionUrl ?? undefined
      });

      if (notify) await this.quota.recordPush(object.externalObjectId);

      await this.markDelivery(delivery.id, status, null, message.messageId);
      await this.refreshNotificationStatus(delivery.notificationId);
    } catch (error) {
      if (error instanceof WalletNotificationQuotaExceededError && wantsPush) {
        const message = await this.wallet.addObjectMessage(object.externalObjectId, {
          header: delivery.notification.header,
          body: this.bodyWithAction(delivery.notification.body, delivery.notification.actionUrl),
          notify: false,
          actionUrl: delivery.notification.actionUrl ?? undefined
        });

        await this.markDelivery(
          delivery.id,
          NotificationDeliveryStatus.DOWNGRADED,
          "QUOTA_EXCEEDED",
          message.messageId
        );
        await this.refreshNotificationStatus(delivery.notificationId);
        return;
      }

      if (error instanceof WalletNotificationTransientError) throw error;

      await this.markDelivery(
        delivery.id,
        error instanceof WalletNotificationNotFoundError
          ? NotificationDeliveryStatus.SKIPPED
          : NotificationDeliveryStatus.FAILED,
        error instanceof Error ? error.name : "UNKNOWN"
      );
      await this.refreshNotificationStatus(delivery.notificationId);
    }
  }

  async processPointsCredit(job: PointsCreditNotificationJob): Promise<void> {
    const member = await this.prisma.member.findFirst({
      where: { id: job.memberId, erasedAt: null },
      include: { walletObjects: true }
    });

    if (!member) return;

    const object = member.walletObjects.find(
      (walletObject) =>
        walletObject.provider === WalletProviderType.GOOGLE &&
        walletObject.status === WalletSyncStatus.SYNCED
    );

    const notification = await this.prisma.notification.create({
      data: {
        clinicId: member.clinicId,
        type: job.tierChanged ? NotificationType.TIER : NotificationType.POINTS,
        header: "Points updated",
        body: `Your balance is now ${job.newBalance}`,
        notify: false,
        deliveries: {
          create: {
            memberId: member.id,
            provider: WalletProviderType.GOOGLE,
            status: object ? NotificationDeliveryStatus.QUEUED : NotificationDeliveryStatus.SKIPPED,
            errorCode: object ? undefined : "NO_GOOGLE_PASS"
          }
        }
      },
      include: { deliveries: true }
    });

    if (!object) {
      await this.refreshNotificationStatus(notification.id);
      return;
    }

    const settings = await this.settingsFor(member.clinicId);
    const shouldNotify =
      settings.notifyOnCredit === ClinicNotifyOnCredit.ALWAYS ||
      (settings.notifyOnCredit === ClinicNotifyOnCredit.MILESTONE_AND_TIER &&
        (job.milestoneReached || job.tierChanged));
    const notify = shouldNotify && (await this.quota.canPush(object.externalObjectId));

    try {
      await this.wallet.patchPoints(object.externalObjectId, {
        points: job.newBalance,
        tier: member.tier ?? undefined,
        notify
      });

      if (notify) await this.quota.recordPush(object.externalObjectId);

      await this.markDelivery(
        notification.deliveries[0].id,
        shouldNotify && !notify
          ? NotificationDeliveryStatus.DOWNGRADED
          : NotificationDeliveryStatus.SENT,
        shouldNotify && !notify ? "QUOTA_RESERVED" : null
      );
      await this.refreshNotificationStatus(notification.id);
    } catch (error) {
      if (error instanceof WalletNotificationQuotaExceededError) {
        await this.wallet.patchPoints(object.externalObjectId, {
          points: job.newBalance,
          tier: member.tier ?? undefined,
          notify: false
        });
        await this.markDelivery(
          notification.deliveries[0].id,
          NotificationDeliveryStatus.DOWNGRADED,
          "QUOTA_EXCEEDED"
        );
        await this.refreshNotificationStatus(notification.id);
        return;
      }

      if (error instanceof WalletNotificationNotFoundError) {
        await this.markDelivery(
          notification.deliveries[0].id,
          NotificationDeliveryStatus.SKIPPED,
          "NOT_FOUND"
        );
        await this.refreshNotificationStatus(notification.id);
        return;
      }

      throw error;
    }
  }

  async list(
    clinicId: string,
    filters: { status?: string; type?: string; cursor?: string },
    actor: NotificationActor
  ) {
    this.assertReader(actor, clinicId);

    const notifications = await this.prisma.notification.findMany({
      where: {
        clinicId,
        ...(filters.status ? { status: filters.status as NotificationStatus } : {}),
        ...(filters.type ? { type: filters.type as NotificationType } : {})
      },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {})
    });

    return {
      items: notifications.slice(0, PAGE_SIZE),
      nextCursor: notifications.length > PAGE_SIZE ? notifications[PAGE_SIZE].id : null
    };
  }

  async get(notificationId: string, actor: NotificationActor) {
    const notification = await this.findNotification(notificationId);

    if (!notification) throw new NotificationNotFoundError();
    this.assertReader(actor, notification.clinicId);

    return { notification, counts: await this.countsFor(notification) };
  }

  async delete(notificationId: string, actor: NotificationActor): Promise<void> {
    const notification = await this.findNotification(notificationId);

    if (!notification) throw new NotificationNotFoundError();
    this.assertSender(actor, notification.clinicId);

    await this.prisma.notification.update({
      where: { id: notification.id },
      data: { status: NotificationStatus.CANCELLED }
    });

    if (notification.type === NotificationType.BROADCAST && notification.providerMessageId) {
      const walletClass = await this.googleClassForClinic(notification.clinicId);
      await this.bestEffortRemove(
        { kind: "class", id: walletClass.externalClassId },
        notification.providerMessageId
      );
      return;
    }

    const deliveries = await this.prisma.notificationDelivery.findMany({
      where: { notificationId: notification.id, providerMessageId: { not: null } },
      include: { member: { include: { walletObjects: true } } }
    });

    await Promise.all(
      deliveries.map(async (delivery) => {
        const object = delivery.member.walletObjects.find(
          (walletObject) => walletObject.provider === WalletProviderType.GOOGLE
        );

        if (object && delivery.providerMessageId) {
          await this.bestEffortRemove(
            { kind: "object", id: object.externalObjectId },
            delivery.providerMessageId
          );
        }
      })
    );
  }

  async quotaForMember(memberId: string, actor: NotificationActor) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, erasedAt: null },
      include: { walletObjects: true }
    });

    if (!member) throw new NotificationNotFoundError("Member not found");
    this.assertReader(actor, member.clinicId);

    const object = member.walletObjects.find(
      (walletObject) => walletObject.provider === WalletProviderType.GOOGLE
    );

    if (!object) return { used: 0, remaining: 0, resetsAt: null };

    return this.quota.usage(object.externalObjectId);
  }

  async getSettings(clinicId: string, actor: NotificationActor) {
    this.assertReader(actor, clinicId);

    return this.settingsFor(clinicId);
  }

  async updateSettings(
    clinicId: string,
    input: NotificationSettingsInput,
    actor: NotificationActor
  ) {
    this.assertSender(actor, clinicId);

    return this.prisma.clinicNotificationSettings.upsert({
      where: { clinicId },
      create: { clinicId, ...input },
      update: input
    });
  }

  async getLocations(clinicId: string, actor: NotificationActor) {
    this.assertReader(actor, clinicId);

    return this.prisma.clinicLocation.findMany({
      where: { clinicId },
      orderBy: { createdAt: "asc" }
    });
  }

  async setLocations(clinicId: string, locations: ClinicLocationInput[], actor: NotificationActor) {
    this.assertSender(actor, clinicId);

    const walletClass = await this.googleClassForClinic(clinicId);

    await this.wallet.setLocations(walletClass.externalClassId, locations);

    const [, ...savedLocations] = await this.prisma.$transaction([
      this.prisma.clinicLocation.deleteMany({ where: { clinicId } }),
      ...locations.map((location) =>
        this.prisma.clinicLocation.create({ data: { clinicId, ...location } })
      )
    ]);

    return savedLocations;
  }

  async resolveSegment(clinicId: string, segment: NotificationSegmentInput) {
    const members = await this.prisma.member.findMany({
      where: { clinicId, erasedAt: null, ...(segment.tier ? { tier: segment.tier } : {}) },
      include: { pointsLedger: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { createdAt: "asc" }
    });
    const cutoff = segment.inactiveDays
      ? new Date(Date.now() - segment.inactiveDays * 24 * 60 * 60 * 1_000)
      : segment.lastVisitBefore;

    return members.filter((member) => {
      if (cutoff) {
        const lastVisitAt = member.pointsLedger[0]?.createdAt ?? member.createdAt;
        if (lastVisitAt >= cutoff) return false;
      }

      if (segment.categoryNotVisited) {
        const category = segment.categoryNotVisited.toLowerCase();
        const hasCategory = member.pointsLedger.some((entry) =>
          `${entry.reason ?? ""} ${entry.sourceRef ?? ""}`.toLowerCase().includes(category)
        );
        if (hasCategory) return false;
      }

      return true;
    });
  }

  private async findNotification(id: string) {
    return this.prisma.notification.findUnique({ where: { id } });
  }

  private async findIdempotent(clinicId: string, idempotencyKey?: string) {
    if (!idempotencyKey) return null;

    return this.prisma.notification.findFirst({ where: { clinicId, idempotencyKey } });
  }

  private async assertMarketingEnabled(clinicId: string): Promise<void> {
    const settings = await this.settingsFor(clinicId);

    if (!settings.marketingEnabled) {
      throw new NotificationForbiddenError("Marketing notifications are disabled for this clinic");
    }
  }

  private async assertBroadcastCapacity(clinicId: string): Promise<void> {
    const count = await this.prisma.notification.count({
      where: {
        clinicId,
        type: NotificationType.BROADCAST,
        createdAt: { gte: new Date(Date.now() - BROADCAST_WINDOW_MS) },
        status: { not: NotificationStatus.CANCELLED }
      }
    });

    if (count >= BROADCAST_LIMIT) {
      throw new NotificationRateLimitError("Broadcast limit reached for this clinic");
    }
  }

  private async settingsFor(clinicId: string) {
    return this.prisma.clinicNotificationSettings.upsert({
      where: { clinicId },
      create: { clinicId },
      update: {}
    });
  }

  private async googleClassForClinic(clinicId: string) {
    const walletClass = await this.prisma.walletClass.findFirst({
      where: {
        provider: WalletProviderType.GOOGLE,
        status: WalletSyncStatus.SYNCED,
        clinicTemplate: { clinicId }
      }
    });

    if (!walletClass) throw new NotificationNotFoundError("Clinic has no Google Wallet class");

    return walletClass;
  }

  private async memberCount(clinicId: string): Promise<number> {
    return this.prisma.member.count({ where: { clinicId, erasedAt: null } });
  }

  private async audit(
    notificationId: string | null,
    clinicId: string,
    actor: NotificationActor,
    action: string,
    recipientCount: number,
    payload?: unknown
  ): Promise<void> {
    await this.prisma.notificationAuditLog.create({
      data: {
        notificationId,
        clinicId,
        actorId: actor.userId,
        action,
        recipientCount,
        payloadJson: payload === undefined ? undefined : (payload as Prisma.InputJsonValue)
      }
    });
  }

  private async markDelivery(
    deliveryId: string,
    status: NotificationDeliveryStatus,
    errorCode?: string | null,
    providerMessageId?: string
  ): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status,
        errorCode,
        providerMessageId,
        sentAt:
          status === NotificationDeliveryStatus.SENT ||
          status === NotificationDeliveryStatus.DOWNGRADED
            ? new Date()
            : undefined
      }
    });
  }

  private async refreshNotificationStatus(notificationId: string): Promise<void> {
    const deliveries = await this.prisma.notificationDelivery.findMany({
      where: { notificationId },
      select: { status: true }
    });

    if (deliveries.some((delivery) => delivery.status === NotificationDeliveryStatus.QUEUED)) {
      return;
    }

    const failed = deliveries.some(
      (delivery) => delivery.status === NotificationDeliveryStatus.FAILED
    );
    const completed = deliveries.some(
      (delivery) =>
        delivery.status === NotificationDeliveryStatus.SENT ||
        delivery.status === NotificationDeliveryStatus.DOWNGRADED ||
        delivery.status === NotificationDeliveryStatus.SKIPPED
    );

    await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        status:
          failed && completed
            ? NotificationStatus.PARTIAL_FAILED
            : failed
              ? NotificationStatus.FAILED
              : NotificationStatus.SENT
      }
    });
  }

  private async countsFor(
    notification: NonNullable<NotificationRecord>
  ): Promise<NotificationCounts> {
    if (notification.type === NotificationType.BROADCAST) {
      const total = await this.memberCount(notification.clinicId);
      const sent = notification.status === NotificationStatus.SENT ? total : 0;

      return {
        total,
        sent,
        downgraded: 0,
        failed: notification.status === NotificationStatus.FAILED ? total : 0,
        skipped: 0
      };
    }

    const rows = await this.prisma.notificationDelivery.groupBy({
      by: ["status"],
      where: { notificationId: notification.id },
      _count: { _all: true }
    });
    const count = (status: NotificationDeliveryStatus) =>
      rows.find((row) => row.status === status)?._count._all ?? 0;

    return {
      total: rows.reduce((sum, row) => sum + row._count._all, 0),
      sent: count(NotificationDeliveryStatus.SENT),
      downgraded: count(NotificationDeliveryStatus.DOWNGRADED),
      failed: count(NotificationDeliveryStatus.FAILED),
      skipped: count(NotificationDeliveryStatus.SKIPPED)
    };
  }

  private assertSender(actor: NotificationActor, clinicId: string): void {
    this.assertReader(actor, clinicId);

    if (!["OWNER", "MANAGER", "VOONE_ADMIN"].includes(actor.role.toUpperCase())) {
      throw new NotificationForbiddenError("Only owners and managers can send notifications");
    }
  }

  private assertReader(actor: NotificationActor, clinicId: string): void {
    if (actor.role.toUpperCase() === "VOONE_ADMIN") return;
    if (actor.clinicId !== clinicId) throw new NotificationForbiddenError();
  }

  private async bestEffortRemove(
    target: { kind: "class"; id: string } | { kind: "object"; id: string },
    messageId: string
  ): Promise<void> {
    try {
      await this.wallet.removeMessage(target, messageId);
    } catch (error) {
      console.warn("[notifications] message removal failed", {
        targetKind: target.kind,
        notificationMessageId: messageId,
        error: error instanceof Error ? error.name : "UNKNOWN"
      });
    }
  }

  private bodyWithAction(body: string, actionUrl?: string | null): string {
    return actionUrl ? `${body}\n${actionUrl}` : body;
  }

  private delayFor(scheduledAt?: Date): number | undefined {
    if (!scheduledAt) return undefined;

    return Math.max(0, scheduledAt.getTime() - Date.now());
  }

  private chunks<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }

    return chunks;
  }
}
