import { WalletProviderType } from "@prisma/client";

import { PassDeviceRegistry, isDeviceRegistry } from "./pass-device-registry.interface";
import { WalletPassProvider } from "./wallet-pass-provider.interface";

/**
 * The wallet providers this deployment can actually use.
 *
 * This is what lets an adapter ship before its credentials exist. `register` asks
 * `isConfigured()` and silently declines a provider that cannot work, so the Apple
 * adapter can be merged and deployed to production with no certificate: it never
 * registers, nothing resolves it, and no business code anywhere contains an `if apple`.
 * The day the certificate lands, four environment variables and a restart make it appear.
 *
 * It replaces wallet.factory.ts, which resolved by platform string and threw for anything
 * it had not been taught.
 */
export class WalletProviderRegistry {
  private readonly providers = new Map<WalletProviderType, WalletPassProvider>();

  /**
   * Returns whether the provider was taken on, so a caller that cares can log the
   * difference between "not deployed" and "deployed but unconfigured" — a distinction
   * worth hours when a clinic reports that half its members got no card.
   */
  register(provider: WalletPassProvider): boolean {
    if (!provider.isConfigured()) {
      return false;
    }

    this.providers.set(provider.provider, provider);

    return true;
  }

  get(provider: WalletProviderType): WalletPassProvider | undefined {
    return this.providers.get(provider);
  }

  has(provider: WalletProviderType): boolean {
    return this.providers.has(provider);
  }

  /** Every usable provider. The fan-out issues and syncs against exactly these. */
  enabled(): WalletPassProvider[] {
    return [...this.providers.values()];
  }

  /**
   * The providers that also keep a device registry, for the endpoints Apple's devices
   * call back on. Selected by capability rather than by asking which vendor it is, so a
   * later provider with the same need is picked up without touching this file.
   */
  deviceRegistries(): (WalletPassProvider & PassDeviceRegistry)[] {
    return this.enabled().filter(isDeviceRegistry);
  }
}
