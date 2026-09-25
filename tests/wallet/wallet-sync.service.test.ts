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
    // person's Apple and Google cards.
    expect(assemble).toHaveBeenCalledTimes(1);
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

describe("InlineWalletSyncQueue", () => {
  const serviceThat = (impl: () => Promise<SyncOutcome[]>) =>
    ({ syncMember: vi.fn(impl) }) as unknown as WalletSyncService;

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
});
