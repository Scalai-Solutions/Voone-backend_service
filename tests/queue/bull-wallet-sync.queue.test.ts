import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The mock is a hand-written class rather than vi.fn(): this suite runs with
 * restoreMocks, which would reset a vi.fn() between cases and hide the recorded calls.
 */
const fake = vi.hoisted(() => ({
  adds: [] as Array<{ name: string; data: unknown; opts: Record<string, unknown> | undefined }>,
  addError: null as Error | null,
  constructed: [] as Array<{ name: string; opts: Record<string, unknown> }>
}));

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(name: string, opts: Record<string, unknown>) {
      fake.constructed.push({ name, opts });
    }

    async add(name: string, data: unknown, opts?: Record<string, unknown>) {
      if (fake.addError) throw fake.addError;
      fake.adds.push({ name, data, opts });
    }

    async close() {}
  },
  Worker: class {}
}));

import { BullWalletSyncQueue } from "../../src/infrastructure/queue/bull-wallet-sync.queue";

describe("BullWalletSyncQueue.enqueueMemberSync", () => {
  beforeEach(() => {
    fake.adds.length = 0;
    fake.constructed.length = 0;
    fake.addError = null;
  });

  it("adds a job on every call, so a later change is never swallowed by an earlier job", async () => {
    const queue = new BullWalletSyncQueue("redis://localhost:6379");

    await queue.enqueueMemberSync("member-1");
    await queue.enqueueMemberSync("member-1");

    expect(fake.adds).toHaveLength(2);
    expect(fake.adds.map((call) => call.data)).toEqual([
      { memberId: "member-1" },
      { memberId: "member-1" }
    ]);
  });

  it("does not pin a job id derived from the member", async () => {
    // BullMQ ignores an add whose id already exists in ANY state, completed and failed
    // included. A fixed id made every change after the first one inside the retention
    // window (an hour, or seven days after a failure) a silent no-op.
    const queue = new BullWalletSyncQueue("redis://localhost:6379");

    await queue.enqueueMemberSync("member-1");
    await queue.enqueueMemberSync("member-1");

    for (const call of fake.adds) {
      expect(call.opts?.jobId).toBeUndefined();
    }
  });

  it("does not use BullMQ deduplication either, which would drop a change made while a sync runs", async () => {
    const queue = new BullWalletSyncQueue("redis://localhost:6379");

    await queue.enqueueMemberSync("member-1");

    expect(fake.adds[0]?.opts?.deduplication).toBeUndefined();
    const defaults = fake.constructed[0]?.opts.defaultJobOptions as Record<string, unknown>;
    expect(defaults.deduplication).toBeUndefined();
    expect(defaults.jobId).toBeUndefined();
  });

  it("keeps the retry policy", () => {
    new BullWalletSyncQueue("redis://localhost:6379");

    expect(fake.constructed[0]?.opts.defaultJobOptions).toMatchObject({
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 }
    });
  });

  it("swallows and logs an error from add", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fake.addError = new Error("redis is down");
    const queue = new BullWalletSyncQueue("redis://localhost:6379");

    await expect(queue.enqueueMemberSync("member-1")).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("member-1");
  });
});
