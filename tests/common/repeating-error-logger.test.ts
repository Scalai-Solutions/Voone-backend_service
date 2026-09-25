import { describe, expect, it } from "vitest";

import { createRepeatingErrorLogger } from "../../src/common/logger/repeating-error-logger";

/**
 * Written against a real incident: a missing ioredis package made BullMQ's worker emit
 * the same connection error without pause, producing 51,477 dropped log lines and
 * tripping Railway's rate limit — which then hid the one line that said what was wrong.
 */
const harness = (intervalMs = 30_000) => {
  const lines: string[] = [];
  let clock = 0;

  const log = createRepeatingErrorLogger(
    "[wallet]",
    intervalMs,
    () => clock,
    (message) => lines.push(message)
  );

  return {
    lines,
    log,
    advance: (ms: number) => {
      clock += ms;
    }
  };
};

describe("createRepeatingErrorLogger", () => {
  it("logs the first occurrence immediately, because that line is the useful one", () => {
    const { lines, log } = harness();

    log(new Error("connection refused"));

    expect(lines).toEqual(["[wallet] connection refused"]);
  });

  it("does not log identical repeats within the interval", () => {
    const { lines, log, advance } = harness();

    log(new Error("connection refused"));
    for (let i = 0; i < 10_000; i += 1) {
      advance(1);
      log(new Error("connection refused"));
    }

    // Ten thousand repeats inside the window produce nothing beyond the first line.
    expect(lines).toHaveLength(1);
  });

  it("reports a count once the interval has passed, so a persistent fault stays visible", () => {
    const { lines, log, advance } = harness(30_000);

    log(new Error("connection refused"));
    log(new Error("connection refused"));
    log(new Error("connection refused"));
    advance(30_000);
    log(new Error("connection refused"));

    // Three, not four: the count is of repeats suppressed since the last line was
    // printed, so it excludes the first occurrence that was already reported.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("repeated 3 time(s)");
  });

  it("logs a different message at once, because a change of error is news", () => {
    const { lines, log } = harness();

    log(new Error("connection refused"));
    log(new Error("connection refused"));
    log(new Error("READONLY replica"));

    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("previous error repeated 1 more time(s)");
    expect(lines[2]).toBe("[wallet] READONLY replica");
  });

  it("does not lose the tail count when the error changes", () => {
    const { lines, log } = harness();

    log(new Error("first"));
    for (let i = 0; i < 5; i += 1) log(new Error("first"));
    log(new Error("second"));

    expect(lines[1]).toContain("repeated 5 more time(s)");
  });

  it("restarts the window after reporting, rather than reporting every call thereafter", () => {
    const { lines, log, advance } = harness(1_000);

    log(new Error("boom"));
    advance(1_000);
    log(new Error("boom")); // reports
    log(new Error("boom")); // inside the fresh window, silent
    log(new Error("boom"));

    expect(lines).toHaveLength(2);
  });
});
