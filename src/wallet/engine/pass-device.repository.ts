import { DeviceRegistration } from "./pass-device-registry.interface";

/**
 * Storage for Apple's pass web service.
 *
 * Separate from WalletSyncRepository because it answers a different question. That one
 * tracks what each provider holds for a member; this one tracks which devices asked to be
 * told when a pass changes, and holds the per-pass bearer token those devices authenticate
 * with. A provider that has no devices needs none of it.
 */
export interface PassDeviceRepository {
  /**
   * Record a device's interest in a pass, replacing any push token it had.
   *
   * Returns whether this created a new registration: Apple distinguishes 201 from 200 on
   * the register call, and a device that re-registers after a token rotation must not be
   * told it is new.
   */
  saveRegistration(registration: Required<DeviceRegistration>): Promise<{ created: boolean }>;

  /** Returns whether a registration was actually removed, which is a 200 either way. */
  removeRegistration(
    deviceLibraryIdentifier: string,
    passTypeIdentifier: string,
    serialNumber: string
  ): Promise<boolean>;

  /**
   * Serials this device holds that changed after `since`, newest change first.
   *
   * `since` absent means "everything you hold" — a device asking for the first time.
   */
  serialsUpdatedSince(
    deviceLibraryIdentifier: string,
    passTypeIdentifier: string,
    since?: Date
  ): Promise<{ serialNumbers: string[]; lastUpdated: Date | null }>;

  /** Every push token registered against a serial, for waking devices on republish. */
  pushTokensFor(passTypeIdentifier: string, serialNumber: string): Promise<string[]>;

  /**
   * The pass's stored bearer token, or null when the pass is unknown or has none.
   *
   * Compared in constant time by the caller — returning it rather than comparing here
   * keeps the repository free of the auth decision.
   */
  authenticationTokenFor(passTypeIdentifier: string, serialNumber: string): Promise<string | null>;

  /** Attach a freshly minted token to an issued pass. */
  setAuthenticationToken(
    passTypeIdentifier: string,
    serialNumber: string,
    token: string
  ): Promise<void>;

  /**
   * What we know about an issued pass, or null if this serial was never ours.
   *
   * A lookup rather than parsing the serial: the serial's shape is the card assembler's
   * business, and a web service that decoded it would break silently the day that
   * changed.
   *
   * `lastUpdated` is the pass's real modification time, which is what the web service
   * must send as Last-Modified. Using "now" instead would make every response look
   * freshly changed and the device's If-Modified-Since could never match — the 304 path
   * would be dead code and every poll would download a full pass.
   */
  passRecordFor(passTypeIdentifier: string, serialNumber: string): Promise<PassRecord | null>;
}

export interface PassRecord {
  memberId: string;
  lastUpdated: Date | null;
}
