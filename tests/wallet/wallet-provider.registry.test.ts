import { WalletProviderType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import type {
  DeviceRegistration,
  PassDeviceRegistry
} from "../../src/wallet/engine/pass-device-registry.interface";
import type {
  InstallArtifact,
  IssuedCard,
  ProgramRef,
  WalletPassProvider
} from "../../src/wallet/engine/wallet-pass-provider.interface";
import { WalletProviderRegistry } from "../../src/wallet/engine/wallet-provider.registry";

class StubProvider implements WalletPassProvider {
  constructor(
    readonly provider: WalletProviderType,
    private readonly configured: boolean
  ) {}

  isConfigured(): boolean {
    return this.configured;
  }

  async provisionProgram(): Promise<ProgramRef> {
    return { provider: this.provider, externalId: "program" };
  }

  async issueCard(): Promise<IssuedCard> {
    return {
      ref: { provider: this.provider, externalId: "card", memberId: "m-1" },
      install: { kind: "link", url: "https://example.test/save" }
    };
  }

  async installArtifact(): Promise<InstallArtifact> {
    return { kind: "link", url: "https://example.test/save" };
  }

  async syncCard(): Promise<void> {}

  async revokeCard(): Promise<void> {}
}

class StubDeviceProvider extends StubProvider implements PassDeviceRegistry {
  async registerDevice(_registration: DeviceRegistration): Promise<void> {}
  async unregisterDevice(_registration: DeviceRegistration): Promise<void> {}
  async serialsUpdatedSince(): Promise<string[]> {
    return [];
  }
  async authenticate(): Promise<boolean> {
    return true;
  }
}

describe("WalletProviderRegistry", () => {
  it("takes on a configured provider", () => {
    const registry = new WalletProviderRegistry();

    expect(registry.register(new StubProvider(WalletProviderType.GOOGLE, true))).toBe(true);
    expect(registry.has(WalletProviderType.GOOGLE)).toBe(true);
  });

  it("declines an unconfigured one, which is how an adapter ships before its credentials", () => {
    const registry = new WalletProviderRegistry();

    expect(registry.register(new StubProvider(WalletProviderType.APPLE, false))).toBe(false);
    expect(registry.has(WalletProviderType.APPLE)).toBe(false);
    expect(registry.get(WalletProviderType.APPLE)).toBeUndefined();
  });

  it("lists only the providers that can actually work", () => {
    const registry = new WalletProviderRegistry();

    registry.register(new StubProvider(WalletProviderType.GOOGLE, true));
    registry.register(new StubDeviceProvider(WalletProviderType.APPLE, false));

    expect(registry.enabled().map((provider) => provider.provider)).toEqual([
      WalletProviderType.GOOGLE
    ]);
  });

  it("selects device registries by capability, not by vendor name", () => {
    const registry = new WalletProviderRegistry();

    registry.register(new StubProvider(WalletProviderType.GOOGLE, true));
    registry.register(new StubDeviceProvider(WalletProviderType.APPLE, true));

    expect(registry.enabled()).toHaveLength(2);
    expect(registry.deviceRegistries().map((provider) => provider.provider)).toEqual([
      WalletProviderType.APPLE
    ]);
  });

  it("replaces a provider registered twice rather than holding both", () => {
    const registry = new WalletProviderRegistry();
    const second = new StubProvider(WalletProviderType.GOOGLE, true);

    registry.register(new StubProvider(WalletProviderType.GOOGLE, true));
    registry.register(second);

    expect(registry.enabled()).toHaveLength(1);
    expect(registry.get(WalletProviderType.GOOGLE)).toBe(second);
  });

  it("is empty before anything registers, so nothing resolves by accident", () => {
    const registry = new WalletProviderRegistry();

    expect(registry.enabled()).toEqual([]);
    expect(registry.deviceRegistries()).toEqual([]);
  });
});
