import { WalletProviderType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoyaltyCard } from "../../src/wallet/engine/loyalty-card";
import type { LoyaltyCardAssembler } from "../../src/wallet/engine/loyalty-card-assembler";
import type {
  CardRef,
  InstallArtifact,
  IssuedCard,
  ProgramRef,
  WalletPassProvider
} from "../../src/wallet/engine/wallet-pass-provider.interface";
import { WalletProviderRegistry } from "../../src/wallet/engine/wallet-provider.registry";
import { InlineWalletSyncQueue } from "../../src/wallet/engine/wallet-sync.queue";
import { WalletSyncService, type SyncOutcome } from "../../src/wallet/engine/wallet-sync.service";
import type { WalletSyncRepository } from "../../src/wallet/engine/wallet-sync.repository";
import { aureaGoldPass } from "../fixtures/loyalty-card.fixture";

const MEMBER = aureaGoldPass.memberId;

class StubProvider implements WalletPassProvider {
  // Typed parameters so the test can assert the card each provider was handed.
  readonly syncCard = vi.fn(async (_ref: CardRef, _card: LoyaltyCard) => {});

  constructor(
    readonly provider: WalletProviderType,
    private readonly configured = true
  ) {}

  isConfigured(): boolean {
    return this.configured;
  }
  async provisionProgram(): Promise<ProgramRef> {
    return { provider: this.provider, externalId: "program" };
  }
  async issueCard(): Promise<IssuedCard> {
    return {
      ref: { provider: this.provider, externalId: "card", memberId: MEMBER },
      install: { kind: "link", url: "https://example.test/save" }
    };
  }
  async installArtifact(): Promise<InstallArtifact> {
    return { kind: "link", url: "https://example.test/save" };
  }

  async revokeCard(): Promise<void> {}
}

const repoWith = (held: WalletProviderType[]): WalletSyncRepository =>
  ({
    findCard: vi.fn(async (memberId: string, provider: WalletProviderType) =>
      held.includes(provider)
        ? ({ provider, externalId: `card-${provider}`, memberId } as CardRef)
        : null
    )
  }) as unknown as WalletSyncRepository;

describe("WalletSyncService", () => {
  let assemble: ReturnType<typeof vi.fn>;
  let assembler: LoyaltyCardAssembler;
  let registry: WalletProviderRegistry;
  let google: StubProvider;
  let apple: StubProvider;

  beforeEach(() => {
    assemble = vi.fn(async () => aureaGoldPass);
    assembler = { assemble } as unknown as LoyaltyCardAssembler;
    registry = new WalletProviderRegistry();
    google = new StubProvider(WalletProviderType.GOOGLE);
    apple = new StubProvider(WalletProviderType.APPLE);
  });

  it("syncs only the providers it is asked to, leaving the others untouched", async () => {
    registry.register(google);
    registry.register(apple);
    const service = new WalletSyncService(
      registry,
      repoWith([WalletProviderType.GOOGLE, WalletProviderType.APPLE]),
      assembler
    );

    const outcomes = await service.syncMember(MEMBER, { providers: [WalletProviderType.APPLE] });

    expect(outcomes).toEqual([{ provider: WalletProviderType.APPLE, result: "synced" }]);
    expect(apple.syncCard).toHaveBeenCalledTimes(1);
    expect(google.syncCard).not.toHaveBeenCalled();
  });

  it("assembles the card once and gives both providers the same one", async () => {
    registry.register(google);
    registry.register(apple);
    const service = new WalletSyncService(
      registry,
      repoWith([WalletProviderType.GOOGLE, WalletProviderType.APPLE]),
      assembler
    );

    await service.syncMember(MEMBER);

    // Two assemblies straddling a ledger write would put different points on the same
    // person's Apple and Google cards. The second call is the freshness re-check AFTER
    // the pushes (see syncMemberChecked), never a card handed to a provider.
    expect(assemble).toHaveBeenCalledTimes(2);
    expect(google.syncCard).toHaveBeenCalledTimes(1);
    expect(apple.syncCard).toHaveBeenCalledTimes(1);
    expect(google.syncCard.mock.calls[0][1]).toBe(apple.syncCard.mock.calls[0][1]);
  });

  it("reports one outcome per enabled provider", async () => {
    registry.register(google);
    registry.register(apple);
    const service = new WalletSyncService(
      registry,
      repoWith([WalletProviderType.GOOGLE, WalletProviderType.APPLE]),
      assembler
    );

    expect(await service.syncMember(MEMBER)).toEqual([
      { provider: WalletProviderType.GOOGLE, result: "synced" },
      { provider: WalletProviderType.APPLE, result: "synced" }
    ]);
  });

  it("keeps syncing the other provider when one fails", async () => {
    registry.register(google);
    registry.register(apple);
    apple.syncCard.mockRejectedValueOnce(new Error("APNs unreachable"));

    const service = new WalletSyncService(
      registry,
      repoWith([WalletProviderType.GOOGLE, WalletProviderType.APPLE]),
      assembler
    );

    const outcomes = await service.syncMember(MEMBER);

    // The point of allSettled: Apple being down must not leave the Google card stale.
    expect(google.syncCard).toHaveBeenCalledTimes(1);
    expect(outcomes).toContainEqual({ provider: WalletProviderType.GOOGLE, result: "synced" });
    expect(outcomes.find((o) => o.provider === WalletProviderType.APPLE)?.result).toBe("failed");
  });

  it("skips a provider the member holds no card with, without calling it", async () => {
    registry.register(google);
    registry.register(apple);
    const service = new WalletSyncService(
      registry,
      repoWith([WalletProviderType.GOOGLE]),
      assembler
    );

    const outcomes = await service.syncMember(MEMBER);

    expect(apple.syncCard).not.toHaveBeenCalled();
    expect(outcomes).toContainEqual({ provider: WalletProviderType.APPLE, result: "no-card" });
  });

  it("ignores an unconfigured provider entirely", async () => {
    registry.register(google);
    registry.register(new StubProvider(WalletProviderType.APPLE, false));

    const service = new WalletSyncService(
      registry,
      repoWith([WalletProviderType.GOOGLE, WalletProviderType.APPLE]),
      assembler
    );

    // A row left behind by a provider since switched off is simply not synced.
    expect(await service.syncMember(MEMBER)).toEqual([
      { provider: WalletProviderType.GOOGLE, result: "synced" }
    ]);
  });

  it("does not even assemble the card when no provider is enabled", async () => {
    const service = new WalletSyncService(registry, repoWith([]), assembler);

    expect(await service.syncMember(MEMBER)).toEqual([]);
    expect(assemble).not.toHaveBeenCalled();
  });
});

describe("WalletSyncService.syncMemberChecked", () => {
  const at = (points: number): LoyaltyCard => ({ ...aureaGoldPass, points });
  let registry: WalletProviderRegistry;
  let google: StubProvider;
  let apple: StubProvider;

  beforeEach(() => {
    registry = new WalletProviderRegistry();
    google = new StubProvider(WalletProviderType.GOOGLE);
    apple = new StubProvider(WalletProviderType.APPLE);
    registry.register(google);
    registry.register(apple);
  });

  const ALL = [WalletProviderType.GOOGLE, WalletProviderType.APPLE];
  const serviceWith = (assemble: ReturnType<typeof vi.fn>, held = ALL) =>
    new WalletSyncService(registry, repoWith(held), {
      assemble
    } as unknown as LoyaltyCardAssembler);

  it("is not stale when the card is unchanged, at the price of exactly one extra read", async () => {
    const assemble = vi.fn(async () => at(1250));

    const result = await serviceWith(assemble).syncMemberChecked(MEMBER);

    expect(result.stale).toBe(false);
    expect(result.outcomes).toEqual([
      { provider: WalletProviderType.GOOGLE, result: "synced" },
      { provider: WalletProviderType.APPLE, result: "synced" }
    ]);
    expect(assemble).toHaveBeenCalledTimes(2);
  });

  it("is stale when the card changed while the sync was pushing the old one", async () => {
    const assemble = vi.fn(async () => at(1250));
    assemble.mockResolvedValueOnce(at(1250)).mockResolvedValueOnce(at(1750));

    const result = await serviceWith(assemble).syncMemberChecked(MEMBER);

    expect(result.stale).toBe(true);
    // What was pushed is still the card read first; the follow-up is the caller's job.
    expect(google.syncCard.mock.calls[0][1].points).toBe(1250);
    expect(result.outcomes.map((o) => o.result)).toEqual(["synced", "synced"]);
  });

  it("does not re-assemble when no provider pushed anything", async () => {
    const assemble = vi.fn(async () => at(1250));

    const result = await serviceWith(assemble, []).syncMemberChecked(MEMBER);

    expect(result.stale).toBe(false);
    expect(result.outcomes.every((o) => o.result === "no-card")).toBe(true);
    expect(assemble).toHaveBeenCalledTimes(1);
  });

  it("does not even assemble when no provider is enabled", async () => {
    const assemble = vi.fn(async () => at(1250));
    const empty = new WalletSyncService(new WalletProviderRegistry(), repoWith([]), {
      assemble
    } as unknown as LoyaltyCardAssembler);

    expect(await empty.syncMemberChecked(MEMBER)).toEqual({ outcomes: [], stale: false });
    expect(assemble).not.toHaveBeenCalled();
  });

  it("treats a failing re-assembly as not stale and keeps the outcomes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const assemble = vi.fn(async () => at(1250));
    assemble.mockResolvedValueOnce(at(1250)).mockRejectedValueOnce(new Error("db blip"));

    const result = await serviceWith(assemble).syncMemberChecked(MEMBER);

    expect(result.stale).toBe(false);
    expect(result.outcomes.map((o) => o.result)).toEqual(["synced", "synced"]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(MEMBER);
  });

  it("keeps a failed provider's outcome intact when the card also changed", async () => {
    apple.syncCard.mockRejectedValueOnce(new Error("APNs unreachable"));
    const assemble = vi.fn(async () => at(1250));
    assemble.mockResolvedValueOnce(at(1250)).mockResolvedValueOnce(at(1750));

    const result = await serviceWith(assemble).syncMemberChecked(MEMBER);

    expect(result.outcomes.find((o) => o.provider === WalletProviderType.APPLE)?.result).toBe(
      "failed"
    );
    expect(result.stale).toBe(true);
  });

  it("syncMember still returns just the outcomes, without the extra read changing them", async () => {
    const assemble = vi.fn(async () => at(1250));

    const outcomes = await serviceWith(assemble).syncMember(MEMBER);

    expect(outcomes).toEqual([
      { provider: WalletProviderType.GOOGLE, result: "synced" },
      { provider: WalletProviderType.APPLE, result: "synced" }
    ]);
  });

  it("compares by content, so a different key order is not a change", async () => {
    const reordered = (card: LoyaltyCard): LoyaltyCard => {
      const entries = Object.entries(card).reverse();
      return Object.fromEntries(entries) as LoyaltyCard;
    };
    const assemble = vi.fn(async () => at(1250));
    assemble.mockResolvedValueOnce(at(1250)).mockResolvedValueOnce(reordered(at(1250)));

    expect((await serviceWith(assemble).syncMemberChecked(MEMBER)).stale).toBe(false);
  });
});

describe("InlineWalletSyncQueue", () => {
  const serviceThat = (impl: () => Promise<SyncOutcome[]>) =>
    ({
      syncMemberChecked: vi.fn(async () => ({ outcomes: await impl(), stale: false }))
    }) as unknown as WalletSyncService;

  const staleService = (staleFor: (call: number) => boolean) => {
    const syncMemberChecked = vi.fn(async () => ({
      outcomes: [] as SyncOutcome[],
      stale: staleFor(syncMemberChecked.mock.calls.length)
    }));
    return { syncMemberChecked, service: { syncMemberChecked } as unknown as WalletSyncService };
  };

  it("returns before the sync finishes, so reception is never made to wait", async () => {
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });

    const queue = new InlineWalletSyncQueue(
      serviceThat(async () => {
        await started;
        return [];
      })
    );

    let returned = false;
    await queue.enqueueMemberSync(MEMBER).then(() => {
      returned = true;
    });

    expect(returned).toBe(true);

    release?.();
    await queue.close();
  });

  it("swallows a thrown sync, because a wallet outage is not a failed visit", async () => {
    const onError = vi.fn();
    const queue = new InlineWalletSyncQueue(
      serviceThat(async () => {
        throw new Error("everything is on fire");
      }),
      onError
    );

    await expect(queue.enqueueMemberSync(MEMBER)).resolves.toBeUndefined();
    await queue.close();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBe(MEMBER);
  });

  it("reports a provider that failed without the sync itself throwing", async () => {
    const onError = vi.fn();
    const queue = new InlineWalletSyncQueue(
      serviceThat(async () => [
        { provider: WalletProviderType.GOOGLE, result: "synced" },
        { provider: WalletProviderType.APPLE, result: "failed", cause: new Error("nope") }
      ]),
      onError
    );

    await queue.enqueueMemberSync(MEMBER);
    await queue.close();

    expect(onError).toHaveBeenCalledOnce();
  });

  it("waits for in-flight work on close, so a shutdown does not strand a sync", async () => {
    let finished = false;
    const queue = new InlineWalletSyncQueue(
      serviceThat(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        finished = true;
        return [];
      })
    );

    await queue.enqueueMemberSync(MEMBER);
    expect(finished).toBe(false);

    await queue.close();
    expect(finished).toBe(true);
  });
  it("runs one follow-up sync when the card changed under the first, still without blocking", async () => {
    const { syncMemberChecked, service } = staleService((call) => call === 1);
    const queue = new InlineWalletSyncQueue(service);

    await queue.enqueueMemberSync(MEMBER);
    await queue.close();

    expect(syncMemberChecked).toHaveBeenCalledTimes(2);
    expect(syncMemberChecked.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      MEMBER,
      MEMBER
    ]);
  });

  it("runs nothing more when the first sync was not stale", async () => {
    const { syncMemberChecked, service } = staleService(() => false);
    const queue = new InlineWalletSyncQueue(service);

    await queue.enqueueMemberSync(MEMBER);
    await queue.close();

    expect(syncMemberChecked).toHaveBeenCalledTimes(1);
  });

  it("stops after 3 re-syncs of a card that never settles, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { syncMemberChecked, service } = staleService(() => true);
    const queue = new InlineWalletSyncQueue(service);

    await queue.enqueueMemberSync(MEMBER);
    await queue.close();

    // The original sync plus three re-checks.
    expect(syncMemberChecked).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `[wallet] sync for member ${MEMBER} still changing after 3 re-checks`
    );
  });

  it("does not follow up a sync that threw or had a failed provider", async () => {
    const onError = vi.fn();
    const syncMemberChecked = vi.fn(async () => ({
      outcomes: [
        { provider: WalletProviderType.APPLE, result: "failed", cause: new Error("nope") }
      ] as SyncOutcome[],
      stale: true
    }));
    const queue = new InlineWalletSyncQueue(
      { syncMemberChecked } as unknown as WalletSyncService,
      onError
    );

    await queue.enqueueMemberSync(MEMBER);
    await queue.close();

    expect(syncMemberChecked).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledOnce();
  });
});
