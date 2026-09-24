import type { PassRefreshChannel } from "./pass-refresh-channel.interface";
import type { CardRef } from "./wallet-pass-provider.interface";

/**
 * A refresh channel that records instead of pushing.
 *
 * Distinct from NoopRefreshChannel, which is a production implementation — doing nothing
 * is genuinely correct for Google. This one exists so that "did the sync try to wake the
 * device?" is answerable, in tests and in local development where no Apple certificate is
 * present and a real push would be impossible anyway.
 *
 * Kept in src rather than tests because local development uses it too: running the API
 * against a real certificate while deliberately not pushing to real phones is a sensible
 * thing to want, and an APNs client that half-works is not.
 */
export class FakeRefreshChannel implements PassRefreshChannel {
  /** Every call, in order. Each entry is one notifyRefresh invocation. */
  readonly calls: CardRef[][] = [];

  constructor(private readonly log?: (message: string) => void) {}

  async notifyRefresh(refs: CardRef[]): Promise<void> {
    this.calls.push(refs);
    this.log?.(
      `[apns:fake] would wake ${refs.length} pass(es): ${refs.map((r) => r.externalId).join(", ")}`
    );
  }

  /** Flattened serial numbers across every call, for the common assertion. */
  get notifiedSerials(): string[] {
    return this.calls.flat().map((ref) => ref.externalId);
  }

  reset(): void {
    this.calls.length = 0;
  }
}
