import {
  NotificationDeliveryStatus,
  Prisma,
  WalletProviderType,
  WalletSyncStatus,
  type AutomationEvent,
  type PrismaClient
} from "@prisma/client";

import { firstName, renderTemplate, type TemplateValues } from "../template";
import { resolveAutomations } from "./automation-settings.service";
import { automationDefinition } from "./catalog";

export interface AutomationRecipient {
  memberId: string;
  /**
   * Values specific to this send (new_tier, benefits_summary, …). first_name, clinic_name,
   * google_maps_link and referral_reward are filled in by the dispatcher.
   */
  values?: TemplateValues;
}

export interface DispatchRequest {
  clinicId: string;
  event: AutomationEvent;
  /** Deterministic for the send (e.g. "referral:<clinic>:2026-11"): a re-run never duplicates. */
  idempotencyKey: string;
  recipients: readonly AutomationRecipient[];
  /** Stored on the Notification for the audit trail. */
  meta?: Record<string, unknown>;
}

export type DispatchSkip = "DISABLED" | "MARKETING_OFF" | "MISSING_CLINIC_VALUE" | "NO_CLINIC";

export interface DispatchResult {
  skipped?: DispatchSkip;
  notificationId?: string;
  recipients: number;
  deliveriesCreated: number;
}

export interface DeliveryEnqueuer {
  enqueueDelivery(deliveryId: string, delayMs?: number): Promise<void>;
}

const WALLET_PROVIDERS = [WalletProviderType.GOOGLE, WalletProviderType.APPLE];
const skipped = (reason: DispatchSkip): DispatchResult => ({
  skipped: reason,
  recipients: 0,
  deliveriesCreated: 0
});

/**
 * Sends one automated message to a list of members: the single path every automation uses
 * (birthday, inactive bono, review request, referral promo, tier upgrade).
 *
 * It owns the rules that are the same for all of them: the clinic's on/off switch, marketing
 * consent, "a required clinic value is set", rendering the copy per member, finding or
 * creating the Notification under its idempotency key, and queueing one delivery per member
 * and wallet. Which members, and when, is the caller's business.
 */
export class AutomationDispatchService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly jobs: DeliveryEnqueuer
  ) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const { clinicId, event, idempotencyKey } = request;
    const definition = automationDefinition(event);
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: {
        name: true,
        notificationSettings: true,
        automations: { where: { event } }
      }
    });

    if (!clinic) return skipped("NO_CLINIC");

    const settings = clinic.notificationSettings;
    const automation = resolveAutomations(clinic.automations)[event];

    if (!automation.enabled) return skipped("DISABLED");
    if (definition.marketing && settings?.marketingEnabled === false) {
      return skipped("MARKETING_OFF");
    }
    if (definition.requires && !settings?.[definition.requires]) {
      return skipped("MISSING_CLINIC_VALUE");
    }

    const clinicValues: Record<string, string> = {
      clinic_name: clinic.name,
      google_maps_link: settings?.googleReviewUrl ?? "",
      referral_reward: settings?.referralRewardText ?? ""
    };
    const members = await this.eligibleMembers(
      clinicId,
      request.recipients.map((recipient) => recipient.memberId),
      definition.marketing
    );
    const valuesByMember = new Map(request.recipients.map((r) => [r.memberId, r.values ?? {}]));
    const notification = await this.prisma.notification.upsert({
      where: { clinicId_idempotencyKey: { clinicId, idempotencyKey } },
      // The template, for reference; every delivery carries the text rendered for its member.
      create: {
        clinicId,
        type: definition.notificationType,
        header: automation.header,
        body: automation.body,
        notify: automation.notify,
        idempotencyKey,
        segmentJson: { automation: event, ...request.meta } as Prisma.InputJsonValue
      },
      update: {}
    });

    const deliveries = members.flatMap((member) => {
      const values = {
        ...clinicValues,
        ...valuesByMember.get(member.id),
        first_name: firstName(member.name)
      };

      return member.walletObjects.map((walletObject) => ({
        notificationId: notification.id,
        memberId: member.id,
        provider: walletObject.provider,
        status: NotificationDeliveryStatus.QUEUED,
        header: renderTemplate(automation.header, values),
        body: renderTemplate(automation.body, values)
      }));
    });
    const created = deliveries.length
      ? await this.prisma.notificationDelivery.createMany({
          data: deliveries,
          skipDuplicates: true
        })
      : { count: 0 };

    // Everything still QUEUED, not just what this run created: a run that died between creating
    // and queueing is finished by the next one.
    const queued = await this.prisma.notificationDelivery.findMany({
      where: { notificationId: notification.id, status: NotificationDeliveryStatus.QUEUED },
      select: { id: true }
    });

    await Promise.all(queued.map((delivery) => this.jobs.enqueueDelivery(delivery.id)));

    if (created.count > 0) {
      await this.prisma.notificationAuditLog.create({
        data: {
          notificationId: notification.id,
          clinicId,
          action: `${event}_CREATED`,
          recipientCount: members.length,
          payloadJson: (request.meta ?? {}) as Prisma.InputJsonValue
        }
      });
    }

    return {
      notificationId: notification.id,
      recipients: members.length,
      deliveriesCreated: created.count
    };
  }

  /** Members who may receive this message and have at least one synced pass. */
  private async eligibleMembers(
    clinicId: string,
    memberIds: readonly string[],
    marketing: boolean
  ) {
    const members: Array<{
      id: string;
      name: string;
      walletObjects: Array<{ provider: WalletProviderType }>;
    }> = [];

    for (let i = 0; i < memberIds.length; i += 1_000) {
      members.push(
        ...(await this.prisma.member.findMany({
          where: {
            clinicId,
            id: { in: memberIds.slice(i, i + 1_000) },
            erasedAt: null,
            ...(marketing ? { consentMarketing: true } : {}),
            walletObjects: {
              some: { status: WalletSyncStatus.SYNCED, provider: { in: WALLET_PROVIDERS } }
            }
          },
          select: {
            id: true,
            name: true,
            walletObjects: {
              where: { status: WalletSyncStatus.SYNCED, provider: { in: WALLET_PROVIDERS } },
              select: { provider: true }
            }
          }
        }))
      );
    }

    return members;
  }
}
