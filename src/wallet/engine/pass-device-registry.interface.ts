import { WalletPassProvider } from "./wallet-pass-provider.interface";

/**
 * Device bookkeeping for providers whose passes live on the device rather than on the
 * provider's servers. In practice: Apple.
 *
 * This is a separate interface on purpose, and the separation is the design. Google Wallet
 * has no devices to register — its objects live on Google's servers and a PATCH reaches
 * every holder — so a shared contract carrying these methods would force the Google
 * adapter to stub four methods it does not mean. Stubs that throw break substitution;
 * stubs that silently no-op are worse, because they make a missing implementation look
 * like a working one.
 *
 * Splitting it means the capability lives in the type. Callers ask
 * `isDeviceRegistry(provider)` rather than `provider.provider === "APPLE"`, so adding a
 * third provider later never means hunting for vendor string comparisons.
 */
export interface PassDeviceRegistry {
  /** A device asks to be told when this pass changes. */
  registerDevice(registration: DeviceRegistration): Promise<void>;

  /** The member deleted the pass, or the device is being retired. */
  unregisterDevice(registration: DeviceRegistration): Promise<void>;

  /**
   * Serial numbers this device holds that changed since it last asked.
   *
   * The caller distinguishes "nothing changed" from "here is a list" by the emptiness of
   * the result; the HTTP layer turns that into Apple's 204-versus-200, which is what
   * decides whether devices back off or keep polling.
   */
  serialsUpdatedSince(deviceLibraryIdentifier: string, since?: Date): Promise<string[]>;

  /**
   * Whether this token may act on this pass.
   *
   * The token is a per-pass secret minted at issue and stored alongside the card, never
   * derived from the serial: serials appear in URLs and barcodes, so a derived token
   * would let anyone who sees one read or deregister that member's pass.
   */
  authenticate(serialNumber: string, authenticationToken: string): Promise<boolean>;
}

export interface DeviceRegistration {
  deviceLibraryIdentifier: string;
  passTypeIdentifier: string;
  serialNumber: string;
  /** Present when registering, absent when unregistering. */
  pushToken?: string;
}

/**
 * Narrows a provider to one that also keeps a device registry.
 *
 * A runtime check rather than a compile-time cast, because the registry hands back
 * providers as WalletPassProvider and only the concrete adapter knows whether it
 * implements this too.
 */
export const isDeviceRegistry = (
  provider: WalletPassProvider
): provider is WalletPassProvider & PassDeviceRegistry =>
  typeof (provider as Partial<PassDeviceRegistry>).registerDevice === "function";
