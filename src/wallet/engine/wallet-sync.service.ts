import { WalletProviderType } from "@prisma/client";

import { LoyaltyCardAssembler } from "./loyalty-card-assembler";
import { WalletProviderRegistry } from "./wallet-provider.registry";
import { WalletSyncRepository } from "./wallet-sync.repository";

export type SyncOutcome =
  | { provider: WalletProviderType; result: "synced" }
  /** The member holds no card with this provider — not a failure, just nothing to do. */
  | { provider: WalletProviderType; result: "no-card" }
  | { provider: WalletProviderType; result: "failed"; cause: unknown };

/**
 * Pushing one member's current card to every wallet that holds it.
 *
 * The card is assembled once and shared, which is what stops the two providers ever
 * disagreeing about a member's points: two assemblies straddling a ledger write would
 * put different numbers on the Apple and Google cards of the same person.
 *
 * Providers are taken from the registry rather than from the stored rows, so a provider
 * that is deployed but unconfigured is skipped rather than failing. A row left behind by
 * a provider since switched off is simply not synced.
 *
 * Knows nothing about queues. The queue calls this; this never calls a queue.
 */
export class WalletSyncService {
  constructor(
    private readonly registry: WalletProviderRegistry,
    private readonly repo: WalletSyncRepository,
    private readonly assembler: LoyaltyCardAssembler
  ) {}

  async syncMember(memberId: string): Promise<SyncOutcome[]> {
    const providers = this.registry.enabled();

    if (providers.length === 0) {
      return [];
    }

    const card = await this.assembler.assemble(memberId);

    // allSettled, never all: the providers are independent and one being down must not
    // stop the other being brought up to date. Each failure is already recorded against
    // its own WalletObject row by the base provider, so it is retried on its own.
    const settled = await Promise.allSettled(
      providers.map(async (provider): Promise<SyncOutcome> => {
        const ref = await this.repo.findCard(memberId, provider.provider);

        if (!ref) {
          return { provider: provider.provider, result: "no-card" };
        }

        await provider.syncCard(ref, card);

        return { provider: provider.provider, result: "synced" };
      })
    );

    return settled.map((outcome, index) =>
      outcome.status === "fulfilled"
        ? outcome.value
        : { provider: providers[index].provider, result: "failed", cause: outcome.reason }
    );
  }
}
