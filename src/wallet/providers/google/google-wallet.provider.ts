import { WalletProviderType } from "@prisma/client";

import { config } from "../../../config/env";
import { BaseWalletProvider } from "../../engine/base-wallet-provider";
import type { LoyaltyCard } from "../../engine/loyalty-card";
import type {
  CardRef,
  InstallArtifact,
  IssuedCard,
  ProgramRef,
  ProgramTemplate,
  WalletMerchantLocation,
  WalletMessageInput,
  WalletMessageRef,
  WalletMessageTarget,
  WalletPointsPatch
} from "../../engine/wallet-pass-provider.interface";
import type { WalletSyncRepository } from "../../engine/wallet-sync.repository";
import { createOrUpdateClass, addClassMessage, removeClassMessage, setClassLocations } from "./classService";
import { GoogleWalletApiError, getGoogleWalletIssuerId, isGoogleWalletConfigured } from "./client";
import { buildSaveLink } from "./jwt";
import { addObjectMessage, createObject, patchObject, removeObjectMessage } from "./objectService";
import type { LoyaltyClassInput, LoyaltyObjectInput } from "./types";
import {
  WalletNotificationAuthError,
  WalletNotificationNotFoundError,
  WalletNotificationQuotaExceededError,
  WalletNotificationTransientError
} from "../../../common/errors/wallet.errors";

const GOOGLE_ID_SAFE_CHARACTER = /[^A-Za-z0-9._-]/g;

const toGoogleSafeSuffix = (value: string): string =>
  value.replace(/-/g, "_").replace(GOOGLE_ID_SAFE_CHARACTER, "_");

const placeholderImageUrl = (
  programName: string,
  hexBackgroundColor: string,
  label: string
): string => {
  const background = hexBackgroundColor.replace("#", "");
  const text = encodeURIComponent(`${programName} ${label}`);

  return `https://placehold.co/1032x336/${background}/FFFFFF.png?text=${text}`;
};

export class GoogleWalletProvider extends BaseWalletProvider {
  readonly provider = WalletProviderType.GOOGLE;

  constructor(repo: WalletSyncRepository) {
    super(repo);
  }

  isConfigured(): boolean {
    return isGoogleWalletConfigured();
  }

  protected async doProvision(template: ProgramTemplate): Promise<ProgramRef> {
    const externalId = this.classIdFor(template.clinicName, template.templateId);

    await createOrUpdateClass(this.toLoyaltyClassInput(template, externalId));

    return { provider: this.provider, externalId };
  }

  protected async doIssue(card: LoyaltyCard, program: ProgramRef): Promise<IssuedCard> {
    const externalId = this.objectIdFor(card.memberId);

    await createObject(this.toLoyaltyObjectInput(card, program.externalId, externalId));

    return {
      ref: { provider: this.provider, externalId, memberId: card.memberId },
      install: this.toInstallArtifact(externalId)
    };
  }

  protected async doInstallArtifact(ref: CardRef): Promise<InstallArtifact> {
    return this.toInstallArtifact(ref.externalId);
  }

  protected async doSync(ref: CardRef, card: LoyaltyCard): Promise<void> {
    await patchObject(ref.externalId, {
      loyaltyPointsBalance: card.points,
      tier: card.tier,
      state: "ACTIVE"
    });
  }

  protected async doRevoke(ref: CardRef): Promise<void> {
    await patchObject(ref.externalId, { state: "INACTIVE" });
  }

  protected async doPatchPoints(objectId: string, patch: WalletPointsPatch): Promise<void> {
    await this.mapNotificationErrors(() =>
      patchObject(objectId, {
        loyaltyPointsBalance: patch.points,
        tier: patch.tier,
        notify: patch.notify
      })
    );
  }

  protected async doAddObjectMessage(
    objectId: string,
    message: WalletMessageInput
  ): Promise<WalletMessageRef> {
    const messageId = await this.mapNotificationErrors(() => addObjectMessage(objectId, message));

    return { messageId };
  }

  protected async doAddClassMessage(
    classId: string,
    message: WalletMessageInput
  ): Promise<WalletMessageRef> {
    const messageId = await this.mapNotificationErrors(() => addClassMessage(classId, message));

    return { messageId };
  }

  protected async doRemoveMessage(target: WalletMessageTarget, messageId: string): Promise<void> {
    await this.mapNotificationErrors(() =>
      target.kind === "class"
        ? removeClassMessage(target.id, messageId)
        : removeObjectMessage(target.id, messageId)
    );
  }

  protected async doSetLocations(
    classId: string,
    locations: WalletMerchantLocation[]
  ): Promise<void> {
    await this.mapNotificationErrors(() => setClassLocations(classId, locations));
  }

  private async mapNotificationErrors<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof GoogleWalletApiError) {
        if (error.status === 404) throw new WalletNotificationNotFoundError(undefined, error);
        if (error.status === 401 || error.status === 403) {
          throw new WalletNotificationAuthError(undefined, error);
        }
        if (error.status === 429 || this.isQuotaError(error.responseBody)) {
          throw new WalletNotificationQuotaExceededError(undefined, error);
        }

        throw new WalletNotificationTransientError(undefined, error);
      }

      throw error;
    }
  }

  private isQuotaError(responseBody: unknown): boolean {
    return JSON.stringify(responseBody).includes("QuotaExceededException");
  }

  private classIdFor(clinicName: string, templateId: string): string {
    return `${getGoogleWalletIssuerId()}.${toGoogleSafeSuffix(`${clinicName}-club-${templateId}`)}`;
  }

  private objectIdFor(memberId: string): string {
    return `${getGoogleWalletIssuerId()}.member_${toGoogleSafeSuffix(memberId)}`;
  }

  private toInstallArtifact(objectId: string): InstallArtifact {
    return { kind: "link", url: buildSaveLink(objectId) };
  }

  private toLoyaltyClassInput(program: ProgramTemplate, classId: string): LoyaltyClassInput {
    const template = program.template;
    const websiteUrl = template.websiteUrl ?? config.FRONTEND_URL;
    const appointmentUrl = template.appointmentUrl;

    return {
      issuerName: program.clinicName,
      classId,
      programName: template.programName,
      hexBackgroundColor: template.backgroundColor,
      logoUrl:
        template.logoUrl ??
        placeholderImageUrl(template.programName, template.backgroundColor, "Logo"),
      heroImageUrl:
        template.heroImageUrl ??
        placeholderImageUrl(template.programName, template.backgroundColor, "Hero"),
      heroImageDescription: `${template.programName} hero image`,
      homepageUrl: websiteUrl,
      accountNameLabel: "Member",
      accountIdLabel: "Member ID",
      rewardsTierLabel: template.tierLabel,
      textModules: [
        {
          id: "clinic",
          header: "Clinic",
          body: program.clinicName
        },
        ...(template.benefitsText
          ? [
              {
                id: "benefits",
                header: "Benefits",
                body: template.benefitsText
              }
            ]
          : []),
        ...(template.infoText
          ? [
              {
                id: "info",
                header: "Information",
                body: template.infoText
              }
            ]
          : [])
      ],
      linkModules: [
        {
          tag: "Website",
          description: "Website",
          url: websiteUrl
        },
        ...(appointmentUrl
          ? [
              {
                tag: "Schedule Appointment",
                description: "Schedule Appointment",
                url: appointmentUrl
              }
            ]
          : [])
      ],
      appLink: appointmentUrl
        ? {
            displayText: template.appLinkText ?? "Schedule Appointment",
            description: template.appLinkDescription ?? "Schedule an appointment",
            url: appointmentUrl
          }
        : undefined
    };
  }

  private toLoyaltyObjectInput(
    card: LoyaltyCard,
    classId: string,
    objectId: string
  ): LoyaltyObjectInput {
    return {
      objectId,
      classId,
      accountName: card.member.fullName,
      accountId: card.redemptionCode,
      memberSince: card.member.memberSince,
      loyaltyPointsLabel: card.template.pointsLabel,
      loyaltyPointsBalance: card.points,
      tier: card.tier,
      state: "ACTIVE"
    };
  }
}

export const createGoogleWalletProvider = (repo: WalletSyncRepository): GoogleWalletProvider =>
  new GoogleWalletProvider(repo);
