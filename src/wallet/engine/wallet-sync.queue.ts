import { nextRecheckDepth } from "./wallet-recheck";
import { WalletSyncService } from "./wallet-sync.service";

/**
 * How a points change asks for the wallets to catch up.
 *
 * A port, so the code that credits a visit never imports a queue library and never waits
 * on a wallet API. That matters at the till: signing a .pkpass and calling two vendors
 * takes seconds, and the member is standing at reception.
 */
/**
 * How long the syncs that follow a reward being issued or redeemed are held back.
 *
 * The visit's credit enqueues its own sync first, and on Google two syncs of one member can
 * overlap: the slower, earlier one could PATCH after the fresh one and leave the card a step
 * behind. A few seconds is far longer than a sync takes and invisible to the member.
 */
export const POST_CHANGE_SYNC_DELAY_MS = 5_000;

export interface WalletSyncQueue {
  /**
   * Ask for this member's wallets to be brought up to date.
   *
   * Never rejects. A queue that throws into the scan flow would make a wallet outage look
   * like a failed payment, which is precisely the coupling this exists to prevent —
   * failures are recorded against the WalletObject row and retried, not raised here.
   *
   * `delayMs` holds the sync back; omitted or 0 runs it as soon as it can, as it always has.
   */
  enqueueMemberSync(memberId: string, delayMs?: number): Promise<void>;

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

  async enqueueMemberSync(memberId: string, delayMs = 0): Promise<void> {
    this.start(memberId, 0, delayMs);
  }

  private start(memberId: string, depth: number, delayMs = 0): void {
    const ready =
      delayMs > 0
        ? new Promise<void>((resolve) => setTimeout(resolve, delayMs))
        : Promise.resolve();
    const task = ready
      .then(() => this.service.syncMemberChecked(memberId))
      .then(({ outcomes, stale }) => {
        const failed = outcomes.filter((outcome) => outcome.result === "failed");

        for (const outcome of failed) {
          if (outcome.result === "failed") this.onError(memberId, outcome.cause);
        }

        // A stale card always gets one more sync, chained up to the cap, so two overlapping
        // syncs converge on the latest card. That holds even when a provider failed: there
        // is no retry here, so the follow-up is also the failed provider's second attempt,
        // and Google may be sitting on the older balance despite Apple having failed.
        const next = nextRecheckDepth(memberId, stale, depth);

        if (next !== null) this.start(memberId, next);
      })
      .catch((cause: unknown) => this.onError(memberId, cause))
      .finally(() => {
        this.inFlight.delete(task);
      });

    this.inFlight.add(task);
  }

  /** Lets a test — or a graceful shutdown — wait for work already started, follow-ups included. */
  async close(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }
}

const defaultOnError = (memberId: string, cause: unknown): void => {
  console.error(`[wallet] inline sync failed for member ${memberId}:`, cause);
};
