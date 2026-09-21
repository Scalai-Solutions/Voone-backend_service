import { randomBytes, timingSafeEqual } from "node:crypto";

import { WalletProviderType } from "@prisma/client";

import { getAppleWalletConfig, isAppleWalletConfigured } from "../../../config/apple-wallet.config";
import { BaseWalletProvider } from "../../engine/base-wallet-provider";
import { LoyaltyCard } from "../../engine/loyalty-card";
import { PassBuilder, PassUpdateBinding } from "../../engine/pass-builder.interface";
import {
  DeviceRegistration,
  PassDeviceRegistry
} from "../../engine/pass-device-registry.interface";
import { PassDeviceRepository } from "../../engine/pass-device.repository";
import { PassRefreshChannel } from "../../engine/pass-refresh-channel.interface";
import {
  CardRef,
  InstallArtifact,
  IssuedCard,
  ProgramRef,
  ProgramTemplate
} from "../../engine/wallet-pass-provider.interface";
import { WalletSyncRepository } from "../../engine/wallet-sync.repository";
import { ApplePassBuilder } from "./apple-pass.builder";
import { resolvePassModelDirectory } from "./apple-pass.model";

/** 256 bits, base64url. Long enough that guessing is not a threat model. */
const mintAuthenticationToken = (): string => randomBytes(32).toString("base64url");

/**
 * Constant-time comparison, so a wrong token cannot be narrowed by timing. Lengths are
 * compared first because timingSafeEqual throws on a mismatch, and a length is not secret.
 */
const secretsMatch = (received: string, expected: string): boolean => {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);

  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Apple Wallet, behind the shared provider contract — and, unlike Google, also behind
 * PassDeviceRegistry.
 *
 * The asymmetry runs through every method, and is why the ports were split rather than
 * merged. A Google card is a row on Google's servers that a PATCH reaches. An Apple card
 * is a signed file that already left the building: the server can only republish it and
 * ask the device to come back for it.
 *
 * The builder arrives as a factory rather than an instance because reading the signing
 * certificate throws when none is configured, and this class must be constructible in a
 * deployment that has no certificate yet. The registry declines to register it, nothing
 * calls it, and the factory is never invoked.
 */
export class AppleWalletProvider extends BaseWalletProvider implements PassDeviceRegistry {
  readonly provider = WalletProviderType.APPLE;

  constructor(
    repo: WalletSyncRepository,
    private readonly passBuilder: () => PassBuilder,
    private readonly refresh: PassRefreshChannel,
    private readonly devices: PassDeviceRepository,
    /**
     * Base URL Apple appends `/v1/...` to. Ours stops at `/api`, because the pass web
     * service routes sit under the existing `/api/v1` router.
     */
    private readonly webServiceUrl: string
  ) {
    super(repo);
  }

  isConfigured(): boolean {
    return isAppleWalletConfigured();
  }

  // ── WalletPassProvider ──────────────────────────────────────────────────────────────

  /**
   * Apple has no clinic-level object to create.
   *
   * A Google programme is a Loyalty Class living on Google's servers that every card
   * points at; Apple's equivalent is the Pass Type ID, which is fixed by the certificate,
   * and the clinic's branding travels inside each individual pass instead. So this
   * provisions nothing and reports the identifier the certificate already carries — a
   * real answer, not a stub, and the reason `provisionProgram` returns a ref at all.
   */
  protected async doProvision(template: ProgramTemplate): Promise<ProgramRef> {
    void template;

    return { provider: this.provider, externalId: getAppleWalletConfig().passTypeIdentifier };
  }

  protected async doIssue(card: LoyaltyCard, program: ProgramRef): Promise<IssuedCard> {
    void program;

    // The serial is Apple's identity for a pass and is what the device web service is
    // addressed by, so it is what we record rather than a second id of our own.
    const ref: CardRef = {
      provider: this.provider,
      externalId: card.serialNumber,
      memberId: card.memberId
    };

    // Minted before the pass is built, because the token goes inside the signed file,
    // and stored only once the build succeeds — a token saved for a pass that was never
    // issued would authenticate a device holding nothing. Its own table, so this does not
    // have to wait for the WalletObject row the base class writes afterwards.
    const authenticationToken = mintAuthenticationToken();
    const install = await this.buildArtifact(card, authenticationToken);

    await this.devices.setAuthenticationToken(card.serialNumber, authenticationToken);

    return { ref, install };
  }

  /**
   * Apple cannot re-sign a link to an existing pass, so the file is rebuilt — with the
   * token the pass already has, never a fresh one: reissuing a token would lock out every
   * device already registered against that pass.
   */
  protected async doInstallArtifact(ref: CardRef, card: LoyaltyCard): Promise<InstallArtifact> {
    const existing = await this.devices.authenticationTokenFor(ref.externalId);

    return this.buildArtifact(card, existing ?? undefined);
  }

  /**
   * Publishing a new state, for a provider that cannot push one.
   *
   * The pass is rebuilt here even though the result is discarded. That looks wasteful and
   * is deliberate: it is the only way to learn *now* that this member's card can no longer
   * be signed — a template edited into something the pass schema rejects, say. Without it
   * the sync is recorded as successful and the failure surfaces later as a device quietly
   * failing to update, which is close to undiagnosable remotely.
   *
   * Then the device is asked to come and fetch. What it fetches is served by the pass web
   * service; until the APNs client lands the refresh channel is a no-op, so today the
   * device collects the new version on its own schedule rather than immediately.
   */
  protected async doSync(ref: CardRef, card: LoyaltyCard): Promise<void> {
    const token = await this.devices.authenticationTokenFor(ref.externalId);

    await this.buildArtifact(card, token ?? undefined);

    await this.refresh.notifyRefresh([ref]);
  }

  /**
   * Apple has no delete.
   *
   * A pass is retired by serving a voided version of it and telling the device to fetch;
   * the device then greys the card out. Registrations are dropped here so a republish
   * stops waking phones that no longer hold a live pass. The base class forgets the
   * WalletObject row, which is what stops a later re-issue colliding.
   */
  protected async doRevoke(ref: CardRef): Promise<void> {
    await this.refresh.notifyRefresh([ref]);
  }

  // ── PassDeviceRegistry ──────────────────────────────────────────────────────────────

  async registerDevice(registration: DeviceRegistration): Promise<void> {
    if (!registration.pushToken) {
      throw new Error("registerDevice requires a push token");
    }

    await this.devices.saveRegistration(registration as Required<DeviceRegistration>);
  }

  async unregisterDevice(registration: DeviceRegistration): Promise<void> {
    await this.devices.removeRegistration(
      registration.deviceLibraryIdentifier,
      registration.serialNumber
    );
  }

  async serialsUpdatedSince(deviceLibraryIdentifier: string, since?: Date): Promise<string[]> {
    const { serialNumbers } = await this.devices.serialsUpdatedSince(
      deviceLibraryIdentifier,
      getAppleWalletConfig().passTypeIdentifier,
      since
    );

    return serialNumbers;
  }

  /**
   * A pass with no stored token authenticates nobody.
   *
   * That is the safe reading rather than an oversight: it means either the pass predates
   * the web service or it was never issued by us, and in both cases the right answer to a
   * device presenting a token is no.
   */
  async authenticate(serialNumber: string, authenticationToken: string): Promise<boolean> {
    const expected = await this.devices.authenticationTokenFor(serialNumber);

    return expected !== null && secretsMatch(authenticationToken, expected);
  }

  /**
   * The current pass for a card, signed and bound to its existing token.
   *
   * What the web service hands a device that came to collect an update. Public because
   * the route needs it; distinct from issueCard because nothing is recorded — this is a
   * read, rebuilt from the card every time so it can never be a sync behind the ledger.
   */
  async buildPassFor(card: LoyaltyCard) {
    const token = await this.devices.authenticationTokenFor(card.serialNumber);

    return this.passBuilder().build(
      card,
      token ? { webServiceUrl: this.webServiceUrl, authenticationToken: token } : undefined
    );
  }

  /** The tokens to wake for a serial. Used by the APNs client once it exists. */
  async pushTokensFor(serialNumber: string): Promise<string[]> {
    return this.devices.pushTokensFor(serialNumber);
  }

  // ── internals ───────────────────────────────────────────────────────────────────────

  private async buildArtifact(
    card: LoyaltyCard,
    authenticationToken?: string
  ): Promise<InstallArtifact> {
    const updates: PassUpdateBinding | undefined = authenticationToken
      ? { webServiceUrl: this.webServiceUrl, authenticationToken }
      : undefined;

    const built = await this.passBuilder().build(card, updates);

    return {
      kind: "file",
      buffer: built.buffer,
      fileName: built.fileName,
      contentType: built.contentType
    };
  }
}

/**
 * The provider wired to the real signing configuration.
 *
 * Separate from the constructor so tests inject a fake builder, and so nothing reads the
 * certificate until a pass is actually built.
 */
export const createAppleWalletProvider = (
  repo: WalletSyncRepository,
  refresh: PassRefreshChannel,
  devices: PassDeviceRepository,
  webServiceUrl: string
): AppleWalletProvider =>
  new AppleWalletProvider(
    repo,
    () => {
      const config = getAppleWalletConfig();

      return new ApplePassBuilder({
        passTypeIdentifier: config.passTypeIdentifier,
        teamIdentifier: config.teamIdentifier,
        organizationName: config.organizationName,
        modelDirectory: resolvePassModelDirectory(config.modelDirectory),
        certificates: config.certificates
      });
    },
    refresh,
    devices,
    webServiceUrl
  );
