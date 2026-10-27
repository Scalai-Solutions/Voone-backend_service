import { WalletProviderType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  createWalletSyncProcessor,
  type WalletSyncJob
} from "../../src/infrastructure/queue/bull-wallet-sync.queue";
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
import type { WalletSyncRepository } from "../../src/wallet/engine/wallet-sync.repository";
import { WalletSyncService } from "../../src/wallet/engine/wallet-sync.service";
import { aureaGoldPass } from "../fixtures/loyalty-card.fixture";

const MEMBER = aureaGoldPass.memberId;

/**
 * The race the freshness re-check exists for, with the REAL service and the REAL job
 * processor; only the database (a mutable balance), the wallet (a recorder) and Redis (an
 * array of jobs) are faked.
 *
 * Two jobs for one member run at once. J1 assembled the card at 1250, then the balance
 * moved to 1750 and J2 assembled that. J2's push reaches the wallet FIRST and J1's, which
 * was held up, lands LAST, so the wallet ends on 1250.
 */
class Wallet {
  readonly pushes: number[] = [];
  private calls = 0;
  private release: () => void = () => undefined;
  private readonly held = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private markReached: () => void = () => undefined;
  readonly firstPushReached = new Promise<void>((resolve) => {
    this.markReached = resolve;
  });

  /** Lets the held first push through. */
  letFirstPushLand(): void {
    this.release();
  }

  readonly provider: WalletPassProvider = {
    provider: WalletProviderType.GOOGLE,
    isConfigured: () => true,
    provisionProgram: async (): Promise<ProgramRef> => ({
      provider: WalletProviderType.GOOGLE,
      externalId: "program"
    }),
    issueCard: async (): Promise<IssuedCard> => {
      throw new Error("not used");
    },
    installArtifact: async (): Promise<InstallArtifact> => ({
      kind: "link",
      url: "https://x.test"
    }),
    revokeCard: async () => undefined,
    syncCard: async (_ref: CardRef, card: LoyaltyCard) => {
      this.calls += 1;

      if (this.calls === 1) {
        this.markReached();
        await this.held;
      }

      this.pushes.push(card.points);
    }
  };

  get landed(): number | undefined {
    return this.pushes[this.pushes.length - 1];
  }
}

const build = (balance: () => number, wallet: Wallet) => {
  const registry = new WalletProviderRegistry();
  registry.register(wallet.provider);
  const repo = {
    findCard: async (memberId: string, provider: WalletProviderType) =>
      ({ provider, externalId: "card", memberId }) as CardRef
  } as unknown as WalletSyncRepository;
  const assembler: LoyaltyCardAssembler = {
    assemble: async () => ({ ...aureaGoldPass, points: balance() })
  };

  return new WalletSyncService(registry, repo, assembler);
};

/** Runs J1 and J2 concurrently the way the two-slot worker would, returning once both are done. */
const raceTwoJobs = async (
  wallet: Wallet,
  balance: { value: number },
  run: (job: WalletSyncJob) => Promise<unknown>
) => {
  const j1 = run({ memberId: MEMBER });
  await wallet.firstPushReached; // J1 has assembled 1250 and is stuck pushing it

  balance.value = 1750; // credit c2
  await run({ memberId: MEMBER }); // J2 assembles 1750 and its push lands first

  wallet.letFirstPushLand(); // J1's older push now lands last
  await j1;
};

describe("two concurrent syncs of one member", () => {
  it("WITHOUT the follow-up, the wallet is left on the stale balance (the bug)", async () => {
    const wallet = new Wallet();
    const balance = { value: 1250 };
    const service = build(() => balance.value, wallet);

    await raceTwoJobs(wallet, balance, (job) => service.syncMember(job.memberId));

    expect(wallet.pushes).toEqual([1750, 1250]);
    expect(wallet.landed).toBe(1250);
  });

  it("WITH the follow-up, the final pushed balance converges to the latest", async () => {
    const wallet = new Wallet();
    const balance = { value: 1250 };
    const service = build(() => balance.value, wallet);
    const followUps: WalletSyncJob[] = [];
    const process = createWalletSyncProcessor(service, async (memberId, recheck) => {
      followUps.push({ memberId, recheck });
    });

    await raceTwoJobs(wallet, balance, (job) => process({ data: job }));

    // J1 saw that the card moved while it was pushing the old one and asked for exactly one
    // more sync; J2 saw nothing change.
    expect(followUps).toEqual([{ memberId: MEMBER, recheck: 1 }]);

    while (followUps.length > 0) {
      await process({ data: followUps.shift() as WalletSyncJob });
    }

    expect(wallet.pushes).toEqual([1750, 1250, 1750]);
    expect(wallet.landed).toBe(1750);
  });

  it("a card that never stops changing is re-synced at most 3 times, then left alone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const wallet = new Wallet();
    wallet.letFirstPushLand();
    let reads = 0;
    // Every single read differs: the worst case, a card field that is not deterministic.
    const service = build(() => ++reads, wallet);
    const followUps: WalletSyncJob[] = [{ memberId: MEMBER }];
    const process = createWalletSyncProcessor(service, async (memberId, recheck) => {
      followUps.push({ memberId, recheck });
    });
    let jobsRun = 0;

    while (followUps.length > 0 && jobsRun < 50) {
      jobsRun += 1;
      await process({ data: followUps.shift() as WalletSyncJob });
    }

    expect(jobsRun).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `[wallet] sync for member ${MEMBER} still changing after 3 re-checks`
    );
  });
});
