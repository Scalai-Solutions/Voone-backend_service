import type { PassDeviceRepository } from "../../engine/pass-device.repository";
import type { PassRefreshChannel } from "../../engine/pass-refresh-channel.interface";
import type { CardRef } from "../../engine/wallet-pass-provider.interface";
import { isDeadToken, type ApnsClient } from "./apns.client";

/**
 * Wakes the devices holding a pass, so a republished pass is collected now rather than
 * whenever the device next happens to poll.
 *
 * Best-effort, as the port promises. Every failure here is swallowed after being logged:
 * the card's authoritative state is whatever syncCard already published, and a member
 * whose phone missed the push gets the new version on the device's own schedule. Letting
 * a push failure fail the sync would mark a card FAILED that is in fact correct.
 */
export class ApnsPassRefreshChannel implements PassRefreshChannel {
  constructor(
    private readonly client: ApnsClient,
    private readonly devices: PassDeviceRepository,
    private readonly passTypeIdentifier: string,
    private readonly log: (message: string) => void = console.warn
  ) {}

  async notifyRefresh(refs: CardRef[]): Promise<void> {
    if (refs.length === 0) return;

    const tokens = await this.tokensFor(refs);

    if (tokens.size === 0) return;

    const results = await Promise.allSettled(
      [...tokens].map(async (token) => {
        const result = await this.client.send(token, this.passTypeIdentifier);

        if (result.status === 200) return;

        if (isDeadToken(result)) {
          // Not a failure worth retrying: this token will never work again. Removing it
          // stops every future republish pushing into a black hole.
          const removed = await this.devices.removeRegistrationsByPushToken(token);
          this.log(
            `[apns] dropped ${removed} registration(s) for a dead token (${result.status} ${result.reason ?? ""})`.trim()
          );
          return;
        }

        this.log(`[apns] push rejected: ${result.status} ${result.reason ?? "no reason given"}`);
      })
    );

    const threw = results.filter((r) => r.status === "rejected");

    if (threw.length > 0) {
      this.log(`[apns] ${threw.length} of ${tokens.size} push(es) threw`);
    }
  }

  /**
   * One push per device, not one per (device, pass).
   *
   * A member can hold several passes on one phone, and the payload says only "something
   * with this pass type changed" — so a device registered for three changed passes needs
   * one wake-up, not three. Deduplicating here rather than letting APNs coalesce keeps
   * the request count honest and avoids tripping Apple's throttling on a bulk sync.
   */
  private async tokensFor(refs: CardRef[]): Promise<Set<string>> {
    const tokens = new Set<string>();

    const lookups = await Promise.allSettled(
      refs.map((ref) => this.devices.pushTokensFor(this.passTypeIdentifier, ref.externalId))
    );

    lookups.forEach((lookup, index) => {
      if (lookup.status === "rejected") {
        this.log(`[apns] could not read push tokens for ${refs[index].externalId}`);
        return;
      }

      lookup.value.forEach((token) => tokens.add(token));
    });

    return tokens;
  }
}
