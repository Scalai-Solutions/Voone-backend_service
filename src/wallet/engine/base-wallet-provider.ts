import { WalletProviderType } from "@prisma/client";

import { WalletSyncError } from "../../common/errors/wallet.errors";
import { LoyaltyCard } from "./loyalty-card";
import {
  CardRef,
  IssuedCard,
  ProgramRef,
  ProgramTemplate,
  WalletPassProvider
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

  protected abstract doProvision(template: ProgramTemplate): Promise<ProgramRef>;

  protected abstract doIssue(card: LoyaltyCard, program: ProgramRef): Promise<IssuedCard>;

  protected abstract doSync(ref: CardRef, card: LoyaltyCard): Promise<void>;

  protected abstract doRevoke(ref: CardRef): Promise<void>;

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
