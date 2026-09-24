import {
  getAppleWalletConfig,
  isAppleWalletConfigured,
  preflightCertificates
} from "../../../config/apple-wallet.config";
import {
  NoopRefreshChannel,
  type PassRefreshChannel
} from "../../engine/pass-refresh-channel.interface";
import type { PassDeviceRepository } from "../../engine/pass-device.repository";
import { ApnsPassRefreshChannel } from "./apns-refresh-channel";
import { Http2ApnsClient } from "./apns.client";

/**
 * Builds the refresh channel the Apple provider should use, given what is configured.
 *
 * Both wiring sites need this decision and neither should own it. Falling back to
 * NoopRefreshChannel rather than throwing keeps the "ships dark" rule the registry
 * already follows: an environment with no certificate runs a provider that publishes
 * passes nobody can install, which is harmless, instead of failing to boot.
 *
 * The pass type identifier is read off the certificate, never configured, for the same
 * reason it is everywhere else here: an APNs topic that disagrees with the certificate
 * signing the pass is rejected by Apple, and configuring it separately is an invitation
 * for the two to drift.
 */
export const createAppleRefreshChannel = (devices: PassDeviceRepository): PassRefreshChannel => {
  if (!isAppleWalletConfigured()) {
    return new NoopRefreshChannel();
  }

  const config = getAppleWalletConfig();

  try {
    const { passTypeIdentifier } = preflightCertificates(config.certificates);

    return new ApnsPassRefreshChannel(
      new Http2ApnsClient(config.certificates),
      devices,
      passTypeIdentifier
    );
  } catch (error) {
    // Unusable signing material. The server already reports this at boot; repeating the
    // failure here would be noise, and throwing would take down an API whose sign-up
    // endpoint needs no wallet at all.
    console.warn(
      `[apns] no push channel: ${error instanceof Error ? error.message : String(error)}`
    );

    return new NoopRefreshChannel();
  }
};
