import { WalletProviderType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  isDeviceRegistry,
  type DeviceRegistration,
  type PassDeviceRegistry
} from "../../src/wallet/engine/pass-device-registry.interface";
import { NoopRefreshChannel } from "../../src/wallet/engine/pass-refresh-channel.interface";
import type {
  CardRef,
  IssuedCard,
  InstallArtifact,
  ProgramRef,
  WalletPassProvider
} from "../../src/wallet/engine/wallet-pass-provider.interface";

/**
 * A provider with no device registry, standing in for Google. The point of these tests is
 * that it compiles and passes without stubbing registerDevice — if the shared contract
 * ever grows a device method, this file stops compiling, which is the alarm we want.
 */
class ServerSideProvider implements WalletPassProvider {
  readonly provider = WalletProviderType.GOOGLE;

  isConfigured(): boolean {
    return true;
  }

  async provisionProgram(): Promise<ProgramRef> {
    return { provider: this.provider, externalId: "issuer.program" };
  }

  async issueCard(): Promise<IssuedCard> {
    return {
      ref: { provider: this.provider, externalId: "issuer.object", memberId: "m-1" },
      install: { kind: "link", url: "https://pay.google.com/gp/v/save/token" }
    };
  }

  async installArtifact(): Promise<InstallArtifact> {
    // Google can re-hand the same save link: the object lives on their servers.
    return { kind: "link", url: "https://pay.google.com/gp/v/save/token" };
  }

  async syncCard(): Promise<void> {}

  async revokeCard(): Promise<void> {}
}

/** A provider that also keeps a device registry, standing in for Apple. */
class DeviceBoundProvider implements WalletPassProvider, PassDeviceRegistry {
  readonly provider = WalletProviderType.APPLE;

  readonly registered: DeviceRegistration[] = [];

  isConfigured(): boolean {
    return true;
  }

  async provisionProgram(): Promise<ProgramRef> {
    return { provider: this.provider, externalId: "pass.com.voone.loyalty" };
  }

  async installArtifact(): Promise<InstallArtifact> {
    // Apple rebuilds the file. It must reuse the token the pass already carries — a
    // fresh one would lock out every device already registered against that pass.
    return {
      kind: "file",
      buffer: Buffer.from("rebuilt"),
      fileName: "card.pkpass",
      contentType: "application/vnd.apple.pkpass"
    };
  }

  async syncCard(): Promise<void> {}

  async revokeCard(): Promise<void> {}

  async issueCard(): Promise<IssuedCard> {
    return {
      ref: { provider: this.provider, externalId: "pass.serial", memberId: "m-1" },
      install: {
        kind: "file",
        buffer: Buffer.from("pkpass"),
        fileName: "pass.serial.pkpass",
        contentType: "application/vnd.apple.pkpass"
      }
    };
  }

  async registerDevice(registration: DeviceRegistration): Promise<void> {
    this.registered.push(registration);
  }

  async unregisterDevice(registration: DeviceRegistration): Promise<void> {
    const at = this.registered.findIndex(
      (candidate) => candidate.deviceLibraryIdentifier === registration.deviceLibraryIdentifier
    );

    if (at !== -1) this.registered.splice(at, 1);
  }

  async serialsUpdatedSince(): Promise<string[]> {
    return [];
  }

  async authenticate(): Promise<boolean> {
    return true;
  }
}

describe("isDeviceRegistry", () => {
  it("recognises a provider that keeps a device registry", () => {
    expect(isDeviceRegistry(new DeviceBoundProvider())).toBe(true);
  });

  it("rejects one that does not, rather than making it stub methods it cannot honour", () => {
    expect(isDeviceRegistry(new ServerSideProvider())).toBe(false);
  });

  it("narrows the type, so callers reach the registry without a cast", async () => {
    const provider: WalletPassProvider = new DeviceBoundProvider();

    expect(isDeviceRegistry(provider)).toBe(true);

    if (isDeviceRegistry(provider)) {
      await provider.registerDevice({
        deviceLibraryIdentifier: "device-1",
        passTypeIdentifier: "pass.com.voone.loyalty",
        serialNumber: "voone-member-000123",
        pushToken: "token"
      });

      expect(await provider.serialsUpdatedSince("device-1")).toEqual([]);
    }
  });
});

describe("the shared contract", () => {
  it("is satisfiable without any device method, which is what keeps Google honest", async () => {
    const provider: WalletPassProvider = new ServerSideProvider();

    await expect(provider.syncCard({} as CardRef, {} as never)).resolves.toBeUndefined();
    await expect(provider.revokeCard({} as CardRef)).resolves.toBeUndefined();
    expect(provider.isConfigured()).toBe(true);
  });

  it("distinguishes the two install artifacts instead of flattening them", async () => {
    const linkArtifact: InstallArtifact = (await new ServerSideProvider().issueCard()).install;
    const fileArtifact: InstallArtifact = (await new DeviceBoundProvider().issueCard()).install;

    expect(linkArtifact.kind).toBe("link");
    expect(fileArtifact.kind).toBe("file");

    // The discriminant is what lets a caller reach the right field without a cast.
    if (linkArtifact.kind === "link") expect(linkArtifact.url).toContain("https://");
    if (fileArtifact.kind === "file") expect(fileArtifact.fileName).toMatch(/\.pkpass$/);
  });
});

describe("NoopRefreshChannel", () => {
  it("does nothing, because a Google PATCH has already reached every holder", async () => {
    await expect(new NoopRefreshChannel().notifyRefresh()).resolves.toBeUndefined();
  });
});
