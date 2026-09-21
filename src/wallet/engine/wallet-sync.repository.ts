import { WalletProviderType } from "@prisma/client";

import { CardRef, ProgramRef } from "./wallet-pass-provider.interface";

/**
 * Where the engine records what each provider currently holds.
 *
 * A port rather than Prisma directly, so BaseWalletProvider — and therefore every adapter
 * built on it — can be tested without a database, and so an adapter never learns how
 * WalletObject rows are shaped.
 *
 * The rows are the engine's memory of provider-side state, not the source of truth for
 * what a card *says*: that is always the LoyaltyCard assembled from the ledger. These
 * rows only answer "have we issued this yet, and did the last sync land".
 */
export interface WalletSyncRepository {
  /** The card this provider already holds for this member, if any. */
  findCard(memberId: string, provider: WalletProviderType): Promise<CardRef | null>;

  /**
   * Record a newly issued card. Upsert, not insert: WalletObject is unique per
   * [memberId, provider], and re-issuing after a failure must not collide.
   */
  recordCard(ref: CardRef): Promise<void>;

  /** The provider now holds the current state. */
  markSynced(ref: CardRef): Promise<void>;

  /**
   * The last attempt did not land.
   *
   * `cause` is for the log, not the row — there is no error column, and inventing one
   * invites storing provider payloads that may carry member data.
   */
  markFailed(ref: CardRef, cause: unknown): Promise<void>;

  /** Forget a revoked card, so a later re-issue starts clean. */
  forgetCard(ref: CardRef): Promise<void>;

  /** The programme this provider already holds for this clinic template, if any. */
  findProgram(templateId: string, provider: WalletProviderType): Promise<ProgramRef | null>;

  /** Record a provisioned programme. Upsert, for the same reason as recordCard. */
  recordProgram(templateId: string, ref: ProgramRef): Promise<void>;
}
