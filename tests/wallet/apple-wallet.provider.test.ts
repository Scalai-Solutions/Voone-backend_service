import { WalletProviderType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WalletSyncError } from "../../src/common/errors/wallet.errors";
import type { LoyaltyCard } from "../../src/wallet/engine/loyalty-card";
import type { BuiltPass, PassBuilder } from "../../src/wallet/engine/pass-builder.interface";
import type { DeviceRegistration } from "../../src/wallet/engine/pass-device-registry.interface";
import type { PassDeviceRepository } from "../../src/wallet/engine/pass-device.repository";
import type { PassRefreshChannel } from "../../src/wallet/engine/pass-refresh-channel.interface";
import type {
  CardRef,
  ProgramRef,
  ProgramTemplate
} from "../../src/wallet/engine/wallet-pass-provider.interface";
import type { WalletSyncRepository } from "../../src/wallet/engine/wallet-sync.repository";
import { AppleWalletProvider } from "../../src/wallet/providers/apple/apple-wallet.provider";
import { aureaGoldPass } from "../fixtures/loyalty-card.fixture";
import { TEST_PASS_TYPE_IDENTIFIER } from "../helpers/test-certificates";

class InMemoryRepository implements WalletSyncRepository {
  readonly cards = new Map<string, CardRef>();
  readonly programs = new Map<string, ProgramRef>();
  readonly status = new Map<string, "SYNCED" | "FAILED">();

  private key(memberId: string, provider: WalletProviderType) {
    return `${memberId}:${provider}`;
  }

  async findCard(memberId: string, provider: WalletProviderType) {
    return this.cards.get(this.key(memberId, provider)) ?? null;
  }
  async recordCard(ref: CardRef) {
    this.cards.set(this.key(ref.memberId, ref.provider), ref);
  }
  async markSynced(ref: CardRef) {
    this.status.set(ref.externalId, "SYNCED");
  }
  async markFailed(ref: CardRef) {
    this.status.set(ref.externalId, "FAILED");
  }
  async forgetCard(ref: CardRef) {
    this.cards.delete(this.key(ref.memberId, ref.provider));
  }
  async findProgram(templateId: string, provider: WalletProviderType) {
    return this.programs.get(`${templateId}:${provider}`) ?? null;
  }
  async recordProgram(templateId: string, ref: ProgramRef) {
    this.programs.set(`${templateId}:${ref.provider}`, ref);
  }
}

class InMemoryDeviceRepository implements PassDeviceRepository {
  readonly registrations = new Map<string, Required<DeviceRegistration>>();
  readonly tokens = new Map<string, string>();
  updatedSince: { serialNumbers: string[]; lastUpdated: Date | null } = {
    serialNumbers: [],
    lastUpdated: null
  };

  private key(device: string, passType: string, serial: string) {
    return `${device}:${passType}:${serial}`;
  }

  /** Mirrors the real primary key: Apple identifies a pass by type AND serial. */
  private credentialKey(passType: string, serial: string) {
    return `${passType}:${serial}`;
  }

  async saveRegistration(registration: Required<DeviceRegistration>) {
    const key = this.key(
      registration.deviceLibraryIdentifier,
      registration.passTypeIdentifier,
      registration.serialNumber
    );
    const created = !this.registrations.has(key);
    this.registrations.set(key, registration);
    return { created };
  }
  async removeRegistration(device: string, passType: string, serial: string) {
    return this.registrations.delete(this.key(device, passType, serial));
  }
  async serialsUpdatedSince() {
    return this.updatedSince;
  }
  async removeRegistrationsByPushToken(pushToken: string) {
    const doomed = [...this.registrations.entries()].filter(([, r]) => r.pushToken === pushToken);
    doomed.forEach(([key]) => this.registrations.delete(key));
    return doomed.length;
  }
  async pushTokensFor(passType: string, serial: string) {
    return [...this.registrations.values()]
      .filter((r) => r.passTypeIdentifier === passType && r.serialNumber === serial)
      .map((r) => r.pushToken);
  }
  async authenticationTokenFor(passType: string, serial: string) {
    return this.tokens.get(this.credentialKey(passType, serial)) ?? null;
  }
  async setAuthenticationToken(passType: string, serial: string, token: string) {
    this.tokens.set(this.credentialKey(passType, serial), token);
  }
  async passRecordFor(passType: string, serial: string) {
    return this.tokens.has(this.credentialKey(passType, serial))
      ? { memberId: "member-for-" + serial, lastUpdated: null }
      : null;
  }
}

const WEB_SERVICE_URL = "https://api.voone.ai/api";

const builtPassFor = (card: LoyaltyCard): BuiltPass => ({
  buffer: Buffer.from(`signed:${card.serialNumber}`),
  fileName: `${card.serialNumber}.pkpass`,
  contentType: "application/vnd.apple.pkpass",
  serialNumber: card.serialNumber
});

const program: ProgramRef = {
  provider: WalletProviderType.APPLE,
  externalId: "pass.com.voone.loyalty"
};

const template: ProgramTemplate = {
  templateId: "tpl-1",
  clinicName: "AURÉA",
  template: aureaGoldPass.template
};

describe("AppleWalletProvider", () => {
  let repo: InMemoryRepository;
  let devices: InMemoryDeviceRepository;
  let build: ReturnType<typeof vi.fn>;
  let notifyRefresh: ReturnType<typeof vi.fn>;
  let refresh: PassRefreshChannel;
  let provider: AppleWalletProvider;

  beforeEach(() => {
    repo = new InMemoryRepository();
    devices = new InMemoryDeviceRepository();
    build = vi.fn(async (card: LoyaltyCard) => builtPassFor(card));
    notifyRefresh = vi.fn(async () => {});
    refresh = { notifyRefresh } as unknown as PassRefreshChannel;
    provider = new AppleWalletProvider(
      repo,
      () => ({ build }) as unknown as PassBuilder,
      refresh,
      devices,
      WEB_SERVICE_URL
    );
  });

  describe("issuing", () => {
    it("mints a token, binds it into the pass, and stores it", async () => {
      await provider.issueCard(aureaGoldPass, program);

      const stored = devices.tokens.get(
        `${TEST_PASS_TYPE_IDENTIFIER}:${aureaGoldPass.serialNumber}`
      );

      expect(stored).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(build.mock.calls[0][1]).toEqual({
        webServiceUrl: WEB_SERVICE_URL,
        authenticationToken: stored
      });
    });

    it("hands back a file, not a link — an Apple pass is downloaded, not fetched by URL", async () => {
      const issued = await provider.issueCard(aureaGoldPass, program);

      expect(issued.install.kind).toBe("file");

      if (issued.install.kind === "file") {
        expect(issued.install.contentType).toBe("application/vnd.apple.pkpass");
        expect(issued.install.fileName).toBe(`${aureaGoldPass.serialNumber}.pkpass`);
      }
    });

    it("records the pass under Apple's own identity for it, the serial", async () => {
      const issued = await provider.issueCard(aureaGoldPass, program);

      expect(issued.ref.externalId).toBe(aureaGoldPass.serialNumber);
      expect(issued.ref.provider).toBe(WalletProviderType.APPLE);
      expect(await repo.findCard(aureaGoldPass.memberId, WalletProviderType.APPLE)).toEqual(
        issued.ref
      );
    });

    it("rebuilds the file for a member who already has a card, since Apple cannot re-sign a link", async () => {
      await provider.issueCard(aureaGoldPass, program);
      const again = await provider.issueCard(aureaGoldPass, program);

      expect(again.install.kind).toBe("file");
      // Once for the first issue, once to rebuild the artifact for the existing card.
      expect(build).toHaveBeenCalledTimes(2);
    });
  });

  describe("provisioning", () => {
    it("reports the pass type identifier rather than creating anything", async () => {
      const ref = await provider.provisionProgram(template);

      // Read off the signing certificate, not invented and not fetched: Apple has no
      // clinic-level object, so there is nothing to create.
      expect(ref).toEqual({
        provider: WalletProviderType.APPLE,
        externalId: TEST_PASS_TYPE_IDENTIFIER
      });
      expect(build).not.toHaveBeenCalled();
    });

    it("provisions once per template and reuses the recorded ref", async () => {
      const first = await provider.provisionProgram(template);
      const second = await provider.provisionProgram(template);

      expect(second).toEqual(first);
      expect(await repo.findProgram("tpl-1", WalletProviderType.APPLE)).toEqual(first);
    });
  });

  describe("syncing", () => {
    const ref: CardRef = {
      provider: WalletProviderType.APPLE,
      externalId: aureaGoldPass.serialNumber,
      memberId: aureaGoldPass.memberId
    };

    it("asks the device to come and fetch, because nothing can be pushed to a file", async () => {
      await provider.syncCard(ref, aureaGoldPass);

      expect(notifyRefresh).toHaveBeenCalledWith([ref]);
      expect(repo.status.get(ref.externalId)).toBe("SYNCED");
    });

    it("rebuilds the pass first, so an unsignable card fails now instead of on the device", async () => {
      await provider.syncCard(ref, aureaGoldPass);

      expect(build.mock.calls[0][0]).toEqual(aureaGoldPass);
    });

    it("rebuilds with the token the pass already has, never a fresh one", async () => {
      // Reissuing a token would lock out every device already registered for this pass.
      devices.tokens.set(
        `${TEST_PASS_TYPE_IDENTIFIER}:${aureaGoldPass.serialNumber}`,
        "existing-token"
      );

      await provider.syncCard(ref, aureaGoldPass);

      expect(build.mock.calls[0][1]).toEqual({
        webServiceUrl: WEB_SERVICE_URL,
        authenticationToken: "existing-token"
      });
    });

    it("binds no web service at all when the pass has no token", async () => {
      await provider.syncCard(ref, aureaGoldPass);

      // Better a frozen pass than one advertising an endpoint that will 401 it forever.
      expect(build.mock.calls[0][1]).toBeUndefined();
    });

    it("fails the sync when the pass can no longer be built, and does not wake the device", async () => {
      build.mockRejectedValueOnce(new Error("template no longer signs"));

      await expect(provider.syncCard(ref, aureaGoldPass)).rejects.toBeInstanceOf(WalletSyncError);

      expect(notifyRefresh).not.toHaveBeenCalled();
      expect(repo.status.get(ref.externalId)).toBe("FAILED");
    });
  });

  describe("revoking", () => {
    it("wakes the device and forgets the card, since Apple has no delete", async () => {
      const issued = await provider.issueCard(aureaGoldPass, program);

      await provider.revokeCard(issued.ref);

      expect(notifyRefresh).toHaveBeenCalledWith([issued.ref]);
      expect(await repo.findCard(aureaGoldPass.memberId, WalletProviderType.APPLE)).toBeNull();
    });
  });

  describe("authenticating a device", () => {
    it("accepts the token stored for that pass", async () => {
      await provider.issueCard(aureaGoldPass, program);
      const token = devices.tokens.get(
        `${TEST_PASS_TYPE_IDENTIFIER}:${aureaGoldPass.serialNumber}`
      ) as string;

      expect(await provider.authenticate(aureaGoldPass.serialNumber, token)).toBe(true);
    });

    it("rejects a token belonging to a different pass", async () => {
      await provider.issueCard(aureaGoldPass, program);
      devices.tokens.set(`${TEST_PASS_TYPE_IDENTIFIER}:other-serial`, "someone-elses-token");

      expect(await provider.authenticate(aureaGoldPass.serialNumber, "someone-elses-token")).toBe(
        false
      );
    });

    it("rejects everything for a pass with no stored token", async () => {
      expect(await provider.authenticate("never-issued", "anything")).toBe(false);
    });
  });

  /**
   * The individual Apple account holds pass.ai.voone.giftcard; the SL will hold
   * pass.ai.voone.loyalty. Serial numbers are derived from the member id, so the same
   * serial exists under both pass types during the migration — and Apple treats those as
   * two entirely different passes. Keying on the serial alone made the second issue
   * overwrite the first one's token, which 401s a pass already sitting in a member's
   * Wallet, with no way to recover it short of re-issuing.
   */
  describe("migrating to a second pass type", () => {
    const FUTURE_PASS_TYPE = "pass.ai.voone.loyalty";

    it("does not accept a token minted for the same serial under another pass type", async () => {
      await provider.issueCard(aureaGoldPass, program);
      devices.tokens.set(`${FUTURE_PASS_TYPE}:${aureaGoldPass.serialNumber}`, "loyalty-token");

      expect(await provider.authenticate(aureaGoldPass.serialNumber, "loyalty-token")).toBe(false);
    });

    it("leaves the other pass type's token intact when it issues its own", async () => {
      devices.tokens.set(`${FUTURE_PASS_TYPE}:${aureaGoldPass.serialNumber}`, "loyalty-token");

      await provider.issueCard(aureaGoldPass, program);

      expect(devices.tokens.get(`${FUTURE_PASS_TYPE}:${aureaGoldPass.serialNumber}`)).toBe(
        "loyalty-token"
      );
      expect(
        devices.tokens.get(`${TEST_PASS_TYPE_IDENTIFIER}:${aureaGoldPass.serialNumber}`)
      ).not.toBe("loyalty-token");
    });
  });

  describe("configuration", () => {
    it("reports itself usable once signing material is present", () => {
      // The suite's global setup generates a throwaway certificate chain whose subject
      // mirrors a real Pass Type ID certificate, so this exercises the same code path
      // production will take the day Apple issues the real one.
      expect(provider.isConfigured()).toBe(true);
    });

    it("is constructible before the builder is ever reachable", () => {
      // The factory is not called at construction. That is what lets this class be
      // deployed, and the registry decline it, in an environment with no certificate.
      const builderFactory = vi.fn(() => {
        throw new Error("no certificate");
      });

      expect(
        () =>
          new AppleWalletProvider(repo, builderFactory as never, refresh, devices, WEB_SERVICE_URL)
            .provider
      ).not.toThrow();
      expect(builderFactory).not.toHaveBeenCalled();
    });
  });
});
