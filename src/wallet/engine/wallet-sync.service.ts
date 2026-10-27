import { WalletProviderType } from "@prisma/client";

import { MemberNotFoundError } from "../../common/errors/membership.errors";
import { cardFingerprint } from "./card-fingerprint";
import type { LoyaltyCard } from "./loyalty-card";
import { LoyaltyCardAssembler } from "./loyalty-card-assembler";
import { WalletProviderRegistry } from "./wallet-provider.registry";
import { WalletSyncRepository } from "./wallet-sync.repository";

export type SyncOutcome =
  | { provider: WalletProviderType; result: "synced" }
  /** The member holds no card with this provider — not a failure, just nothing to do. */
  | { provider: WalletProviderType; result: "no-card" }
  | { provider: WalletProviderType; result: "failed"; cause: unknown };

export interface CheckedSync {
  outcomes: SyncOutcome[];
  /**
   * The member's card changed while this sync was pushing, so what it pushed is out of date
   * and another sync must run afterwards. Never true when the card could not be re-read.
   */
  stale: boolean;
}

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

  /**
   * `options.providers` narrows the push to some wallets (a clinic message to an Apple card has
   * no business re-patching the Google object); the card is still assembled once.
   */
  async syncMember(
    memberId: string,
    options: { providers?: WalletProviderType[] } = {}
  ): Promise<SyncOutcome[]> {
    return (await this.syncMemberChecked(memberId, options)).outcomes;
  }

  /**
   * `syncMember`, plus whether the card went stale while it ran.
   *
   * Two syncs of one member can run at the same time, and each assembles its card once at
   * the start, so the one holding the OLDER card can push last and leave the wallet behind
   * until the next change. After pushing, the card is therefore read once more: if it
   * differs from what was pushed, the caller must run another sync. That is correct under
   * any concurrency, because whichever sync pushed an out-of-date card is the one that
   * sees the difference. It costs one extra read, and none when nothing was pushed to a
   * wallet that can go stale (Apple's pass is rebuilt from the database on fetch).
   *
   * A failed re-read never fails the sync (the pushes already happened): it is logged and
   * reported as not stale.
   */
  async syncMemberChecked(
    memberId: string,
    options: { providers?: WalletProviderType[] } = {}
  ): Promise<CheckedSync> {
    const wanted = options.providers;
    const providers = this.registry
      .enabled()
      .filter((provider) => !wanted || wanted.includes(provider.provider));

    if (providers.length === 0) {
      return { outcomes: [], stale: false };
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

    const outcomes = settled.map((outcome, index): SyncOutcome =>
      outcome.status === "fulfilled"
        ? outcome.value
        : { provider: providers[index].provider, result: "failed", cause: outcome.reason }
    );

    // Nothing to re-check when nothing was pushed, or when only Apple was: its pass is
    // rebuilt from the database whenever a phone fetches it, so the order two syncs
    // pushed in cannot leave an Apple card stale.
    const pushedAnywhereButApple = outcomes.some(
      (outcome) => outcome.result !== "no-card" && outcome.provider !== WalletProviderType.APPLE
    );

    if (!pushedAnywhereButApple) {
      return { outcomes, stale: false };
    }

    return { outcomes, stale: await this.changedSince(memberId, card) };
  }

  private async changedSince(memberId: string, pushed: LoyaltyCard): Promise<boolean> {
    try {
      const current = await this.assembler.assemble(memberId);

      return cardFingerprint(current) !== cardFingerprint(pushed);
    } catch (cause) {
      // A member erased mid-sync has no card to be stale about: not worth an error line.
      if (cause instanceof MemberNotFoundError) return false;

      console.error(`[wallet] could not re-check the card of member ${memberId}:`, cause);

      return false;
    }
  }
}
