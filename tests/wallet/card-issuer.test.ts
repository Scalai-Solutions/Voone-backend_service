import { WalletProviderType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { CardIssuer } from "../../src/modules/wallet/card-issuer";
import type { LoyaltyCard } from "../../src/wallet/engine/loyalty-card";
import type {
  CardRef,
  InstallArtifact,
  IssuedCard,
  ProgramRef,
  ProgramTemplate,
  WalletPassProvider
} from "../../src/wallet/engine/wallet-pass-provider.interface";
import { WalletProviderRegistry } from "../../src/wallet/engine/wallet-provider.registry";
import type { WalletSyncRepository } from "../../src/wallet/engine/wallet-sync.repository";
import { aureaGoldPass } from "../fixtures/loyalty-card.fixture";

const MEMBER = aureaGoldPass.memberId;

const fileArtifact = (marker: string): InstallArtifact => ({
  kind: "file",
  buffer: Buffer.from(marker),
  fileName: "card.pkpass",
  contentType: "application/vnd.apple.pkpass"
});

class Provider implements WalletPassProvider {
  readonly provider = WalletProviderType.APPLE;
  issued = 0;
  rebuilt = 0;

  isConfigured(): boolean {
    return true;
  }

  async provisionProgram(): Promise<ProgramRef> {
    return { provider: this.provider, externalId: "pass.ai.voone.giftcard" };
  }

  async issueCard(): Promise<IssuedCard> {
    this.issued += 1;

    return {
      ref: { provider: this.provider, externalId: aureaGoldPass.serialNumber, memberId: MEMBER },
      install: fileArtifact("freshly-issued")
    };
  }

  async installArtifact(): Promise<InstallArtifact> {
    this.rebuilt += 1;

    return fileArtifact("rebuilt-with-existing-token");
  }

  async syncCard(): Promise<void> {}
  async revokeCard(): Promise<void> {}
}

const build = (existing: CardRef | null) => {
  const provider = new Provider();
  const registry = new WalletProviderRegistry();
  registry.register(provider);

  const cards = {
    findCard: async () => existing
  } as unknown as WalletSyncRepository;

  const assembler = { assemble: async (): Promise<LoyaltyCard> => aureaGoldPass };

  const program: ProgramTemplate = {
    templateId: "tpl-1",
    clinicName: "AURÉA",
    template: aureaGoldPass.template
  };

  return {
    provider,
    issuer: new CardIssuer(registry, cards, assembler, async () => program)
  };
};

describe("CardIssuer", () => {
  it("issues a card for a member who has none", async () => {
    const { issuer, provider } = build(null);

    const artifact = await issuer.artifactFor(MEMBER, WalletProviderType.APPLE);

    expect(provider.issued).toBe(1);
    expect(artifact.kind === "file" && artifact.buffer.toString()).toBe("freshly-issued");
  });

  it("does NOT re-issue for a member who already has one", async () => {
    // The point of the whole class. Re-issuing mints a new authentication token, and for
    // Apple that silently locks out every device already registered against the pass —
    // so a member asking for their card again on a new phone would break the old one.
    const { issuer, provider } = build({
      provider: WalletProviderType.APPLE,
      externalId: aureaGoldPass.serialNumber,
      memberId: MEMBER
    });

    const artifact = await issuer.artifactFor(MEMBER, WalletProviderType.APPLE);

    expect(provider.issued).toBe(0);
    expect(provider.rebuilt).toBe(1);
    expect(artifact.kind === "file" && artifact.buffer.toString()).toBe(
      "rebuilt-with-existing-token"
    );
  });

  it("refuses when the provider is not configured, rather than issuing nothing", async () => {
    const registry = new WalletProviderRegistry();
    const issuer = new CardIssuer(
      registry,
      { findCard: async () => null } as unknown as WalletSyncRepository,
      { assemble: async () => aureaGoldPass },
      async () => ({
        templateId: "tpl-1",
        clinicName: "AURÉA",
        template: aureaGoldPass.template
      })
    );

    await expect(issuer.artifactFor(MEMBER, WalletProviderType.APPLE)).rejects.toThrow(
      /not configured/
    );
  });

  it("assembles before issuing, so a member who cannot be rendered writes nothing", async () => {
    const provider = new Provider();
    const registry = new WalletProviderRegistry();
    registry.register(provider);

    const issuer = new CardIssuer(
      registry,
      { findCard: async () => null } as unknown as WalletSyncRepository,
      {
        assemble: async () => {
          throw new Error("clinic has no template");
        }
      },
      async () => ({
        templateId: "tpl-1",
        clinicName: "AURÉA",
        template: aureaGoldPass.template
      })
    );

    await expect(issuer.artifactFor(MEMBER, WalletProviderType.APPLE)).rejects.toThrow();
    expect(provider.issued).toBe(0);
  });
});
