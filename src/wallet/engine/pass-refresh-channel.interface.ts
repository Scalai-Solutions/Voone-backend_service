import { CardRef } from "./wallet-pass-provider.interface";

/**
 * How a provider tells devices that a card they hold has changed.
 *
 * Apple needs one: a pass is a file on the device, so after republishing it the server
 * sends a silent APNs push and the device calls back to collect the new version. Google
 * needs none: patching the loyalty object already reaches every holder, so its channel is
 * a no-op — expressed as an object that does nothing rather than as an `if` at the call
 * site, so the fan-out never has to ask which provider it is talking to.
 */
export interface PassRefreshChannel {
  /**
   * Ask the holders of these cards to refresh.
   *
   * Best-effort by nature: a push can be dropped and a device can be offline for days.
   * Nothing may depend on this having arrived — the card's authoritative state is
   * whatever `syncCard` already published, and this only shortens the wait.
   */
  notifyRefresh(refs: CardRef[]): Promise<void>;
}

/**
 * The channel for providers that need no push. Doing nothing is the correct behaviour
 * here, not a missing implementation.
 */
export class NoopRefreshChannel implements PassRefreshChannel {
  async notifyRefresh(): Promise<void> {
    // Google's PATCH has already reached every holder.
  }
}
