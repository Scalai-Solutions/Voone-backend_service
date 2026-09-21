import { WalletSyncService } from "./wallet-sync.service";

/**
 * How a points change asks for the wallets to catch up.
 *
 * A port, so the code that credits a visit never imports a queue library and never waits
 * on a wallet API. That matters at the till: signing a .pkpass and calling two vendors
 * takes seconds, and the member is standing at reception.
 */
export interface WalletSyncQueue {
  /**
   * Ask for this member's wallets to be brought up to date.
   *
   * Never rejects. A queue that throws into the scan flow would make a wallet outage look
   * like a failed payment, which is precisely the coupling this exists to prevent —
   * failures are recorded against the WalletObject row and retried, not raised here.
   */
  enqueueMemberSync(memberId: string): Promise<void>;

  close(): Promise<void>;
}

/**
 * Runs the sync immediately, in this process.
 *
 * The default, and honest about what it is: there is no retry, no durability, and a
 * restart loses anything in flight. It exists so the whole system works before Redis is
 * provisioned — the call sites are already correct, and switching to the real queue is a
 * configuration change rather than a code change.
 *
 * It still does not block the caller: the work is started and deliberately not awaited.
 */
export class InlineWalletSyncQueue implements WalletSyncQueue {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly service: WalletSyncService,
    private readonly onError: (memberId: string, cause: unknown) => void = defaultOnError
  ) {}

  async enqueueMemberSync(memberId: string): Promise<void> {
    const task = this.service
      .syncMember(memberId)
      .then((outcomes) => {
        for (const outcome of outcomes) {
          if (outcome.result === "failed") this.onError(memberId, outcome.cause);
        }
      })
      .catch((cause: unknown) => this.onError(memberId, cause))
      .finally(() => {
        this.inFlight.delete(task);
      });

    this.inFlight.add(task);
  }

  /** Lets a test — or a graceful shutdown — wait for work already started. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }
}

const defaultOnError = (memberId: string, cause: unknown): void => {
  console.error(`[wallet] inline sync failed for member ${memberId}:`, cause);
};
