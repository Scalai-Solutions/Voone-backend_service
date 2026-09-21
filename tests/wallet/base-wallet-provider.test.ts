import { WalletProviderType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WalletSyncError } from "../../src/common/errors/wallet.errors";
import { BaseWalletProvider } from "../../src/wallet/engine/base-wallet-provider";
import type { LoyaltyCard } from "../../src/wallet/engine/loyalty-card";
import type {
  CardRef,
  IssuedCard,
  ProgramRef,
  ProgramTemplate
} from "../../src/wallet/engine/wallet-pass-provider.interface";
import type { WalletSyncRepository } from "../../src/wallet/engine/wallet-sync.repository";
import { aureaGoldPass } from "../fixtures/loyalty-card.fixture";

/** In-memory stand-in for the WalletObject / WalletClass rows. */
class InMemoryRepository implements WalletSyncRepository {
  readonly cards = new Map<string, CardRef>();
  readonly programs = new Map<string, ProgramRef>();
  readonly status = new Map<string, "SYNCED" | "FAILED">();
  readonly failures: unknown[] = [];

  private cardKey(memberId: string, provider: WalletProviderType) {
    return `${memberId}:${provider}`;
  }

  async findCard(memberId: string, provider: WalletProviderType) {
    return this.cards.get(this.cardKey(memberId, provider)) ?? null;
  }

  async recordCard(ref: CardRef) {
    this.cards.set(this.cardKey(ref.memberId, ref.provider), ref);
  }

  async markSynced(ref: CardRef) {
    this.status.set(ref.externalId, "SYNCED");
  }

  async markFailed(ref: CardRef, cause: unknown) {
    this.status.set(ref.externalId, "FAILED");
    this.failures.push(cause);
  }

  async forgetCard(ref: CardRef) {
    this.cards.delete(this.cardKey(ref.memberId, ref.provider));
  }

  async findProgram(templateId: string, provider: WalletProviderType) {
    return this.programs.get(`${templateId}:${provider}`) ?? null;
  }

  async recordProgram(templateId: string, ref: ProgramRef) {
    this.programs.set(`${templateId}:${ref.provider}`, ref);
  }
}

/** A minimal concrete provider, so the base class's own behaviour is what is under test. */
class TestProvider extends BaseWalletProvider {
  readonly provider = WalletProviderType.GOOGLE;

  configured = true;
  syncShouldFail = false;

  readonly doProvision = vi.fn(async (template: ProgramTemplate): Promise<ProgramRef> => ({
    provider: this.provider,
    externalId: `issuer.${template.templateId}`
  }));

  readonly doIssue = vi.fn(async (card: LoyaltyCard): Promise<IssuedCard> => ({
    ref: {
      provider: this.provider,
      externalId: `object.${card.serialNumber}`,
      memberId: card.memberId
    },
    install: { kind: "link", url: `https://pay.example/${card.serialNumber}` }
  }));

  readonly doSync = vi.fn(async (): Promise<void> => {
    if (this.syncShouldFail) throw new Error("provider said no");
  });

  readonly doRevoke = vi.fn(async (): Promise<void> => {});

  readonly doInstallArtifact = vi.fn(async (ref: CardRef): Promise<IssuedCard["install"]> => ({
    kind: "link",
    url: `https://pay.example/again/${ref.externalId}`
  }));

  isConfigured(): boolean {
    return this.configured;
  }
}

const template: ProgramTemplate = {
  templateId: "tpl-1",
  clinicName: "AURÉA",
  template: aureaGoldPass.template
};

describe("BaseWalletProvider", () => {
  let repo: InMemoryRepository;
  let provider: TestProvider;

  beforeEach(() => {
    repo = new InMemoryRepository();
    provider = new TestProvider(repo);
  });

  describe("provisionProgram", () => {
    it("provisions once and records the result", async () => {
      const ref = await provider.provisionProgram(template);

      expect(ref.externalId).toBe("issuer.tpl-1");
      expect(await repo.findProgram("tpl-1", WalletProviderType.GOOGLE)).toEqual(ref);
    });

    it("does not provision a second programme for the same template", async () => {
      const first = await provider.provisionProgram(template);
      const second = await provider.provisionProgram(template);

      expect(second).toEqual(first);
      expect(provider.doProvision).toHaveBeenCalledTimes(1);
    });
  });

  describe("issueCard", () => {
    const program: ProgramRef = { provider: WalletProviderType.GOOGLE, externalId: "issuer.tpl-1" };

    it("issues a card and records it against the member", async () => {
      const issued = await provider.issueCard(aureaGoldPass, program);

      expect(issued.ref.memberId).toBe(aureaGoldPass.memberId);
      expect(await repo.findCard(aureaGoldPass.memberId, WalletProviderType.GOOGLE)).toEqual(
        issued.ref
      );
    });

    it("returns the existing card rather than issuing a duplicate", async () => {
      const first = await provider.issueCard(aureaGoldPass, program);
      const second = await provider.issueCard(aureaGoldPass, program);

      expect(second.ref).toEqual(first.ref);
      expect(provider.doIssue).toHaveBeenCalledTimes(1);
    });

    it("still rebuilds the install artifact for a card that already exists", async () => {
      await provider.issueCard(aureaGoldPass, program);
      const again = await provider.issueCard(aureaGoldPass, program);

      expect(provider.doInstallArtifact).toHaveBeenCalledTimes(1);
      expect(again.install).toEqual({
        kind: "link",
        url: "https://pay.example/again/object.voone-member-000123"
      });
    });
  });

  describe("syncCard", () => {
    const ref: CardRef = {
      provider: WalletProviderType.GOOGLE,
      externalId: "object.voone-member-000123",
      memberId: aureaGoldPass.memberId
    };

    it("marks the card synced when the provider accepts it", async () => {
      await provider.syncCard(ref, aureaGoldPass);

      expect(repo.status.get(ref.externalId)).toBe("SYNCED");
    });

    it("marks the card failed and raises a WalletSyncError when the provider refuses", async () => {
      provider.syncShouldFail = true;

      await expect(provider.syncCard(ref, aureaGoldPass)).rejects.toBeInstanceOf(WalletSyncError);
      expect(repo.status.get(ref.externalId)).toBe("FAILED");
    });

    it("keeps the provider's cause, so an operator can see what was actually refused", async () => {
      provider.syncShouldFail = true;

      await expect(provider.syncCard(ref, aureaGoldPass)).rejects.toSatisfy(
        (error: WalletSyncError) => (error.cause as Error).message === "provider said no"
      );
      expect(repo.failures).toHaveLength(1);
    });

    it("does not expose the message, which can carry a provider payload", async () => {
      provider.syncShouldFail = true;

      await expect(provider.syncCard(ref, aureaGoldPass)).rejects.toSatisfy(
        (error: WalletSyncError) => error.expose === false && error.statusCode === 502
      );
    });
  });

  describe("revokeCard", () => {
    it("forgets the card, so a later re-issue starts clean", async () => {
      const program: ProgramRef = {
        provider: WalletProviderType.GOOGLE,
        externalId: "issuer.tpl-1"
      };
      const issued = await provider.issueCard(aureaGoldPass, program);

      await provider.revokeCard(issued.ref);

      expect(await repo.findCard(aureaGoldPass.memberId, WalletProviderType.GOOGLE)).toBeNull();

      await provider.issueCard(aureaGoldPass, program);
      expect(provider.doIssue).toHaveBeenCalledTimes(2);
    });
  });
});
