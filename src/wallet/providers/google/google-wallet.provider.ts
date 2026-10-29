import { WalletProviderType } from "@prisma/client";

import { config } from "../../../config/env";
import { DEFAULT_WALLET_BENEFIT_CTA } from "../../../modules/templates/default-voone-template";
import { availableRewardCount, availableRewardsText } from "../../engine/rewards-text";
import { boostText } from "../../engine/boost-text";
import { tierBenefitsText } from "../../engine/tier-benefits-text";
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
import {
  createOrUpdateClass,
  addClassMessage,
  removeClassMessage,
  setClassLocations
} from "./classService";
import { GoogleWalletApiError, getGoogleWalletIssuerId, isGoogleWalletConfigured } from "./client";
import { buildSaveLink } from "./jwt";
import { addObjectMessage, createObject, patchObject, removeObjectMessage } from "./objectService";
import type {
  LoyaltyClassInput,
  LoyaltyObjectInput,
  LoyaltyRewardsInput,
  LoyaltyOptionalModuleInput,
  LoyaltyTierBenefitsInput
} from "./types";
import {
  WalletNotificationAuthError,
  WalletNotificationNotFoundError,
  WalletNotificationQuotaExceededError,
  WalletNotificationTransientError
} from "../../../common/errors/wallet.errors";

// Google's text module body is a short card detail, not a document. The tier benefits text is
// already fitted to the same 500 by the assembler.
const GOOGLE_REWARDS_BODY_MAX = 500;

const GOOGLE_ID_SAFE_CHARACTER = /[^A-Za-z0-9._-]/g;

const toGoogleSafeSuffix = (value: string): string =>
  value.replace(/-/g, "_").replace(GOOGLE_ID_SAFE_CHARACTER, "_");

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

  /**
   * Re-PATCH an existing class from its template. `provisionProgram` deliberately returns a
   * recorded class untouched (a template saved twice must not create a second one), so this is the
   * only way a change to the class's own layout reaches classes that already exist.
   */
  async refreshClass(template: ProgramTemplate, ref: ProgramRef): Promise<void> {
    await createOrUpdateClass(this.toLoyaltyClassInput(template, ref.externalId));
  }

  protected async doIssue(card: LoyaltyCard, program: ProgramRef): Promise<IssuedCard> {
    const externalId = this.objectIdFor(card.memberId);

    const input = this.toLoyaltyObjectInput(card, program.externalId, externalId);

    try {
      await createObject(input);
    } catch (error) {
      // The rewards and the tier benefits are additions to the card: if Google refuses them the
      // member still gets a card, and the next sync tries them again on their own.
      if (
        (!input.rewards && !input.tierBenefits && !input.boost) ||
        !(error instanceof GoogleWalletApiError) ||
        error.status !== 400
      ) {
        throw error;
      }

      console.error(
        "[wallet] Google refused the newer card fields; creating the card without them",
        {
          error: error.name,
          status: error.status
        }
      );
      await createObject({
        ...input,
        rewards: undefined,
        tierBenefits: undefined,
        boost: undefined
      });
    }

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

    // The rewards and the tier benefits go in a patch of their own, after the one that matters: a
    // Google rejection of these newer fields must never stop the balance and tier updating. Both
    // rewards are undefined for a clinic with no programme, which leaves them alone. A card with no
    // tier benefits (no live programme, or a tier with none) removes a stale module from the object.
    const rewards = this.toRewards(card);
    const tierBenefits = this.toTierBenefits(card);
    const boost = this.toBoost(card);

    try {
      await patchObject(ref.externalId, {
        ...(rewards ? { rewards } : {}),
        tierBenefits: tierBenefits ?? null,
        // Nothing pending removes a stale module, exactly as for the tier benefits.
        boost: boost ?? null
      });
    } catch (error) {
      console.error("[wallet] Google card rewards and tier benefits were not updated", {
        error: error instanceof Error ? error.name : "unknown",
        status: error instanceof GoogleWalletApiError ? error.status : undefined
      });
    }
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
      // The plain Voone logo when the clinic has none (absent if that is not configured),
      // and no hero at all: another client's images are never a fallback.
      logoUrl: template.logoUrl ?? config.VOONE_DEFAULT_LOGO_URL,
      heroImageUrl: template.heroImageUrl,
      heroImageDescription: `Imagen de ${template.programName}`,
      homepageUrl: websiteUrl,
      accountNameLabel: "Nombre de miembro",
      accountIdLabel: "N.º de miembro",
      rewardsTierLabel: template.tierLabel,
      textModules: [
        {
          id: "clinic",
          header: "Centro",
          body: program.clinicName
        },
        {
          id: "benefit_cta",
          header: "Beneficio",
          body: DEFAULT_WALLET_BENEFIT_CTA
        },
        // A clinic whose live programme owns the benefits shows them per member instead (the
        // object's tierbenefits module), so its hand-typed text is not shown to everybody.
        ...(template.benefitsText && !program.tierBenefitsFromProgramme
          ? [
              {
                id: "benefits",
                header: "Beneficios",
                body: template.benefitsText
              }
            ]
          : []),
        ...(template.infoText
          ? [
              {
                id: "info",
                header: "Información",
                body: template.infoText
              }
            ]
          : [])
      ],
      linkModules: [
        {
          tag: "Web",
          description: "Web",
          url: websiteUrl
        },
        ...(appointmentUrl
          ? [
              {
                tag: "Reservar cita",
                description: "Reservar cita",
                url: appointmentUrl
              }
            ]
          : [])
      ],
      appLink: appointmentUrl
        ? {
            displayText: template.appLinkText ?? "Reservar cita",
            description: template.appLinkDescription ?? "Reservar cita",
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
      tierLabel: card.template.tierLabel,
      tier: card.tier,
      rewards: this.toRewards(card),
      tierBenefits: this.toTierBenefits(card),
      boost: this.toBoost(card),
      state: "ACTIVE"
    };
  }

  /** The same words the Apple back field carries, so the two wallets never disagree. */
  private toBoost(card: LoyaltyCard): LoyaltyOptionalModuleInput | undefined {
    const text = boostText(card);

    return text === undefined ? undefined : { text };
  }

  /** The same words the Apple back field carries, so the two wallets never disagree. */
  private toTierBenefits(card: LoyaltyCard): LoyaltyTierBenefitsInput | undefined {
    const text = tierBenefitsText(card);

    return text === undefined ? undefined : { text };
  }

  /** The same words the Apple back field carries, so the two wallets never disagree. */
  private toRewards(card: LoyaltyCard): LoyaltyRewardsInput | undefined {
    const text = availableRewardsText(card, GOOGLE_REWARDS_BODY_MAX);

    return text === undefined ? undefined : { count: availableRewardCount(card), text };
  }
}

export const createGoogleWalletProvider = (repo: WalletSyncRepository): GoogleWalletProvider =>
  new GoogleWalletProvider(repo);
