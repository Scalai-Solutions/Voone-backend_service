import { WalletProviderType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import type { SyncOutcome } from "../../src/wallet/engine/wallet-sync.service";
import { WalletSyncAppleCardRefresher } from "../../src/wallet/apple-card-refresher";

const refresherReturning = (outcomes: SyncOutcome[]) => {
  const syncMember = vi.fn(async () => outcomes);

  return { syncMember, refresher: new WalletSyncAppleCardRefresher({ syncMember }) };
};

describe("WalletSyncAppleCardRefresher", () => {
  it("syncs only the member's Apple card", async () => {
    const { syncMember, refresher } = refresherReturning([
      { provider: WalletProviderType.APPLE, result: "synced" }
    ]);

    await expect(refresher.refreshMemberCard("member-1")).resolves.toBeUndefined();
    expect(syncMember).toHaveBeenCalledWith("member-1", { providers: [WalletProviderType.APPLE] });
  });

  it("rejects when the Apple sync failed, so the delivery is not marked SENT", async () => {
    const { refresher } = refresherReturning([
      { provider: WalletProviderType.APPLE, result: "failed", cause: new Error("sign failed") }
    ]);

    await expect(refresher.refreshMemberCard("member-1")).rejects.toThrow("sign failed");
  });

  it("rejects when there was no Apple card to refresh or the provider is not enabled", async () => {
    await expect(
      refresherReturning([
        { provider: WalletProviderType.APPLE, result: "no-card" }
      ]).refresher.refreshMemberCard("member-1")
    ).rejects.toThrow(/no Apple card/i);
    await expect(refresherReturning([]).refresher.refreshMemberCard("member-1")).rejects.toThrow(
      /not enabled/i
    );
  });
});
