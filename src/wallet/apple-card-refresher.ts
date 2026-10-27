import { WalletProviderType } from "@prisma/client";

import type { AppleCardRefresher } from "../modules/notifications/notification.service";
import type { WalletSyncService } from "./engine/wallet-sync.service";

/**
 * Brings one member's Apple card up to date and says whether it worked.
 *
 * A clinic message reaches Apple as a pass field, so delivering it is the ordinary card
 * sync: the pass is rebuilt (the assembler reads the stored message), the provider
 * validates that it can be signed and asks the member's devices to collect it.
 *
 * Unlike the queue's fire-and-forget enqueue, this awaits the result and rejects on any
 * failure, because the caller marks the delivery SENT only on the strength of it. Only the
 * Apple card is synced; Google has its own message API and nothing to do here.
 */
export class WalletSyncAppleCardRefresher implements AppleCardRefresher {
  constructor(private readonly sync: Pick<WalletSyncService, "syncMember">) {}

  async refreshMemberCard(memberId: string): Promise<void> {
    const outcomes = await this.sync.syncMember(memberId, {
      providers: [WalletProviderType.APPLE]
    });
    const apple = outcomes.find((outcome) => outcome.provider === WalletProviderType.APPLE);

    if (!apple) throw new Error("The Apple Wallet provider is not enabled");
    if (apple.result === "no-card") throw new Error("The member has no Apple card to refresh");
    if (apple.result === "failed") {
      throw apple.cause instanceof Error ? apple.cause : new Error(String(apple.cause));
    }
  }
}
