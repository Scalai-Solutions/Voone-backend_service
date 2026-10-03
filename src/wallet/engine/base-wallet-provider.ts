import { WalletProviderType } from "@prisma/client";

import {
  WalletNotificationNotImplementedError,
  WalletSyncError
} from "../../common/errors/wallet.errors";
import { LoyaltyCard } from "./loyalty-card";
import {
  CardRef,
  InstallArtifact,
  IssuedCard,
  ProgramRef,
  ProgramTemplate,
  WalletMerchantLocation,
  WalletMessageInput,
  WalletMessageRef,
  WalletMessageTarget,
  WalletPassProvider,
  WalletPointsPatch
} from "./wallet-pass-provider.interface";
import { WalletSyncRepository } from "./wallet-sync.repository";

/**
 * Everything both adapters would otherwise write twice.
 *
 * Template Method: `provisionProgram`, `issueCard`, `syncCard` and `revokeCard` are final
 * and own the bookkeeping — the idempotency check, the WalletObject row, the status
 * transitions, the error wrapping. Subclasses implement only `doProvision`, `doIssue`,
 * `doSync` and `doRevoke`, which are the parts that genuinely differ between a Google
 * object and a signed .pkpass.
 *
 * Without this the two lanes each grow their own copy of the persistence logic and drift
 * within a fortnight — and a status transition that one adapter forgets is invisible until
 * a member's card silently stops updating.
 */
export abstract class BaseWalletProvider implements WalletPassProvider {
  abstract readonly provider: WalletProviderType;

  constructor(protected readonly repo: WalletSyncRepository) {}

  abstract isConfigured(): boolean;

  /**
   * Idempotent per clinic template: a template saved twice must not create a second
   * programme, because the provider-side id is what every issued card points at.
   */
  async provisionProgram(template: ProgramTemplate): Promise<ProgramRef> {
    const existing = await this.repo.findProgram(template.templateId, this.provider);

    if (existing) {
      return existing;
    }

    const ref = await this.doProvision(template);

    await this.repo.recordProgram(template.templateId, ref);

    return ref;
  }

  /**
   * Idempotent per member: a member who signs up twice, or whose first issue failed after
   * the provider call landed, gets the card they already have rather than a duplicate.
   * The install artifact is rebuilt either way, since that is what the caller needs to
   * hand back.
   */
  async issueCard(card: LoyaltyCard, program: ProgramRef): Promise<IssuedCard> {
    const existing = await this.repo.findCard(card.memberId, this.provider);

    if (existing) {
      const install = await this.doInstallArtifact(existing, card);

      return { ref: existing, install };
    }

    const issued = await this.doIssue(card, program);

    await this.repo.recordCard(issued.ref);

    return issued;
  }

  /**
   * Public counterpart of doInstallArtifact, which already knows to reuse the token the
   * pass carries rather than minting one.
   */
  async installArtifact(ref: CardRef, card: LoyaltyCard): Promise<InstallArtifact> {
    return this.doInstallArtifact(ref, card);
  }

  async syncCard(ref: CardRef, card: LoyaltyCard): Promise<void> {
    try {
      await this.doSync(ref, card);
      await this.repo.markSynced(ref);
    } catch (cause) {
      // Marked before rethrowing: the fan-out settles every provider independently, so a
      // row left PENDING here would be indistinguishable from one never attempted.
      await this.repo.markFailed(ref, cause);

      throw new WalletSyncError(`${this.provider} sync failed for card ${ref.externalId}`, cause);
    }
  }

  /** Idempotent: revoking a card the provider has already dropped is not an error. */
  async revokeCard(ref: CardRef): Promise<void> {
    await this.doRevoke(ref);
    await this.repo.forgetCard(ref);
  }

  patchPoints(objectId: string, patch: WalletPointsPatch): Promise<void> {
    return this.doPatchPoints(objectId, patch);
  }

  addObjectMessage(objectId: string, message: WalletMessageInput): Promise<WalletMessageRef> {
    return this.doAddObjectMessage(objectId, message);
  }

  addClassMessage(classId: string, message: WalletMessageInput): Promise<WalletMessageRef> {
    return this.doAddClassMessage(classId, message);
  }

  removeMessage(target: WalletMessageTarget, messageId: string): Promise<void> {
    return this.doRemoveMessage(target, messageId);
  }

  setLocations(classId: string, locations: WalletMerchantLocation[]): Promise<void> {
    return this.doSetLocations(classId, locations);
  }

  protected abstract doProvision(template: ProgramTemplate): Promise<ProgramRef>;

  protected abstract doIssue(card: LoyaltyCard, program: ProgramRef): Promise<IssuedCard>;

  protected abstract doSync(ref: CardRef, card: LoyaltyCard): Promise<void>;

  protected abstract doRevoke(ref: CardRef): Promise<void>;

  protected doPatchPoints(objectId: string, patch: WalletPointsPatch): Promise<void> {
    void objectId;
    void patch;

    throw new WalletNotificationNotImplementedError();
  }

  protected doAddObjectMessage(
    objectId: string,
    message: WalletMessageInput
  ): Promise<WalletMessageRef> {
    void objectId;
    void message;

    throw new WalletNotificationNotImplementedError();
  }

  protected doAddClassMessage(
    classId: string,
    message: WalletMessageInput
  ): Promise<WalletMessageRef> {
    void classId;
    void message;

    throw new WalletNotificationNotImplementedError();
  }

  protected doRemoveMessage(target: WalletMessageTarget, messageId: string): Promise<void> {
    void target;
    void messageId;

    throw new WalletNotificationNotImplementedError();
  }

  protected doSetLocations(
    classId: string,
    locations: WalletMerchantLocation[]
  ): Promise<void> {
    void classId;
    void locations;

    throw new WalletNotificationNotImplementedError();
  }

  /**
   * How a member installs a card that already exists.
   *
   * Separate from `doIssue` because the two diverge: Google can re-sign a save link for an
   * existing object, while Apple has to rebuild and re-sign the whole file.
   */
  protected abstract doInstallArtifact(
    ref: CardRef,
    card: LoyaltyCard
  ): Promise<IssuedCard["install"]>;
}
