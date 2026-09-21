import { WalletProviderType } from "@prisma/client";

import { getAppleWalletConfig, isAppleWalletConfigured } from "../../../config/apple-wallet.config";
import { BaseWalletProvider } from "../../engine/base-wallet-provider";
import { LoyaltyCard } from "../../engine/loyalty-card";
import { PassBuilder } from "../../engine/pass-builder.interface";
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

/**
 * Apple Wallet, behind the shared provider contract.
 *
 * The asymmetry with Google runs through every method here, and is the reason the ports
 * were split rather than merged. A Google card is a row on Google's servers that a PATCH
 * reaches. An Apple card is a signed file that already left the building — the server can
 * only republish it and ask the device to come back for it.
 *
 * The builder arrives as a factory rather than an instance because reading the signing
 * certificate throws when none is configured, and this class must be constructible in a
 * deployment that has no certificate yet. The registry declines to register it, nothing
 * calls it, and the factory is never invoked.
 */
export class AppleWalletProvider extends BaseWalletProvider {
  readonly provider = WalletProviderType.APPLE;

  constructor(
    repo: WalletSyncRepository,
    private readonly passBuilder: () => PassBuilder,
    private readonly refresh: PassRefreshChannel
  ) {
    super(repo);
  }

  isConfigured(): boolean {
    return isAppleWalletConfigured();
  }

  /**
   * Apple has no clinic-level object to create.
   *
   * A Google programme is a Loyalty Class living on Google's servers that every card
   * points at; Apple's equivalent is the Pass Type ID, which is fixed by the certificate,
   * and the clinic's branding travels inside each individual pass instead. So this
   * provisions nothing and reports the identifier the certificate already carries — a
   * real answer, not a stub, and the reason `provisionProgram` returns a ref rather than
   * void.
   */
  protected async doProvision(template: ProgramTemplate): Promise<ProgramRef> {
    void template;

    return { provider: this.provider, externalId: getAppleWalletConfig().passTypeIdentifier };
  }

  protected async doIssue(card: LoyaltyCard, program: ProgramRef): Promise<IssuedCard> {
    void program;

    return {
      // The serial is Apple's identity for a pass and is what the device web service is
      // addressed by, so it is what we record rather than a second id of our own.
      ref: { provider: this.provider, externalId: card.serialNumber, memberId: card.memberId },
      install: await this.buildArtifact(card)
    };
  }

  /** Apple cannot re-sign a link to an existing pass: the file is rebuilt every time. */
  protected async doInstallArtifact(ref: CardRef, card: LoyaltyCard): Promise<InstallArtifact> {
    void ref;

    return this.buildArtifact(card);
  }

  /**
   * Publishing a new state, for a provider that cannot push one.
   *
   * The pass is rebuilt here even though the result is discarded. That looks wasteful and
   * is deliberate: it is the only way to learn *now* that this member's card can no longer
   * be signed — a template edited to something the pass schema rejects, say. Without it
   * the sync would be recorded as successful and the failure would surface later as a
   * device quietly failing to update, which is close to undiagnosable remotely.
   *
   * Then the device is asked to come and fetch. What it fetches is served by the device
   * web service, which is not built yet, so today this reaches no phone — the refresh
   * channel is a no-op until the APNs client lands.
   */
  protected async doSync(ref: CardRef, card: LoyaltyCard): Promise<void> {
    await this.passBuilder().build(card);

    await this.refresh.notifyRefresh([ref]);
  }

  /**
   * Apple has no delete.
   *
   * A pass is retired by serving a voided version of it and telling the device to fetch;
   * the device then greys the card out and stops showing it on the lock screen. Serving
   * that voided version is the device web service's job, so all this can do is ask the
   * device to come back. The base class forgets the row either way, which is what stops a
   * later re-issue colliding.
   */
  protected async doRevoke(ref: CardRef): Promise<void> {
    await this.refresh.notifyRefresh([ref]);
  }

  private async buildArtifact(card: LoyaltyCard): Promise<InstallArtifact> {
    const built = await this.passBuilder().build(card);

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
  refresh: PassRefreshChannel
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
    refresh
  );
