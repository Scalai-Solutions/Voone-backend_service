import { WalletProviderType } from "@prisma/client";

import { WalletConfigurationError } from "../../common/errors/wallet.errors";
import type { LoyaltyCardAssembler } from "../../wallet/engine/loyalty-card-assembler";
import type {
  InstallArtifact,
  ProgramTemplate
} from "../../wallet/engine/wallet-pass-provider.interface";
import type { WalletProviderRegistry } from "../../wallet/engine/wallet-provider.registry";
import type { WalletSyncRepository } from "../../wallet/engine/wallet-sync.repository";

/**
 * Produces the thing a member installs.
 *
 * Until now nothing ever called issueCard: the sync service only brings EXISTING cards up
 * to date and reports "no-card" otherwise, and the only route serving a .pkpass is the
 * device web service, which requires the per-pass token a device is given when it
 * installs. So there was no way to install a first pass at all — a chicken-and-egg that
 * would have been discovered at the pilot.
 *
 * The provider is asked for the artifact rather than the file, so this stays honest for
 * Google too: its artifact is a save link, not a download.
 */
export class CardIssuer {
  constructor(
    private readonly registry: WalletProviderRegistry,
    private readonly cards: WalletSyncRepository,
    private readonly assembler: LoyaltyCardAssembler,
    private readonly programFor: (memberId: string) => Promise<ProgramTemplate>
  ) {}

  /**
   * The installable artifact for this member with this provider, issuing the card first
   * if they do not have one.
   *
   * Issuing is not repeated for a member who already has a card. That is the whole reason
   * the two paths are distinguished: re-issuing mints a new authentication token, and for
   * Apple that silently locks out every device already registered against the pass. A
   * member asking for their card a second time — new phone, deleted by accident — must
   * get the same pass back, not a new one.
   */
  async artifactFor(memberId: string, provider: WalletProviderType): Promise<InstallArtifact> {
    const adapter = this.registry.get(provider);

    if (!adapter) {
      throw new WalletConfigurationError(
        `${provider} wallet is not configured, so no card can be issued.`
      );
    }

    // Assembled first: it validates the member and the clinic's template, so a clinic
    // with no template fails before anything is written.
    const card = await this.assembler.assemble(memberId);
    const existing = await this.cards.findCard(memberId, provider);

    if (existing) {
      return adapter.installArtifact(existing, card);
    }

    const program = await adapter.provisionProgram(await this.programFor(memberId));
    const issued = await adapter.issueCard(card, program);

    return issued.install;
  }
}
