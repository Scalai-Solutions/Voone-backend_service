/**
 * Collapses a repeating error into one line plus a periodic count.
 *
 * BullMQ reconnects forever by design — `maxRetriesPerRequest: null` is required on the
 * connections it blocks on — so an error that cannot resolve itself is re-emitted as fast
 * as the event loop allows. A bare `console.error` in that listener turns one fault into a
 * log flood: a single missing `ioredis` package produced over 51,000 dropped lines in one
 * deploy and tripped Railway's 500 lines/sec limit, which then hid the very first line
 * that said what was wrong.
 *
 * The first occurrence is always logged immediately, because the first line is the useful
 * one. Identical repeats are counted and reported at most once per interval. A different
 * message logs immediately — a change of error is news.
 */
const DEFAULT_INTERVAL_MS = 30_000;

export const createRepeatingErrorLogger = (
  prefix: string,
  intervalMs: number = DEFAULT_INTERVAL_MS,
  now: () => number = Date.now,
  sink: (message: string) => void = console.error
): ((error: Error) => void) => {
  let lastMessage: string | null = null;
  let lastReportedAt = 0;
  let suppressed = 0;

  return (error: Error): void => {
    const message = error.message;

    if (message !== lastMessage) {
      // A new fault. Report any tail left over from the previous one rather than losing
      // the count silently.
      if (suppressed > 0) {
        sink(`${prefix} previous error repeated ${suppressed} more time(s)`);
      }

      lastMessage = message;
      lastReportedAt = now();
      suppressed = 0;
      sink(`${prefix} ${message}`);
      return;
    }

    suppressed += 1;

    if (now() - lastReportedAt >= intervalMs) {
      sink(
        `${prefix} ${message} (repeated ${suppressed} time(s) in the last ${Math.round(intervalMs / 1000)}s)`
      );
      lastReportedAt = now();
      suppressed = 0;
    }
  };
};
