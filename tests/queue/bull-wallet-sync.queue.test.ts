import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The mock is a hand-written class rather than vi.fn(): this suite runs with
 * restoreMocks, which would reset a vi.fn() between cases and hide the recorded calls.
 */
const fake = vi.hoisted(() => ({
  adds: [] as Array<{ name: string; data: unknown; opts: Record<string, unknown> | undefined }>,
  addError: null as Error | null,
  constructed: [] as Array<{ name: string; opts: Record<string, unknown> }>,
  workers: [] as Array<{
    processor: (job: { data: unknown }) => Promise<unknown>;
    opts: Record<string, unknown>;
    listeners: Record<string, () => void>;
  }>,
  queuesClosed: 0
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

    async close() {
      fake.queuesClosed += 1;
    }
  },
  Worker: class {
    readonly listeners: Record<string, () => void> = {};

    constructor(
      _name: string,
      processor: (job: { data: unknown }) => Promise<unknown>,
      opts: Record<string, unknown>
    ) {
      fake.workers.push({ processor, opts, listeners: this.listeners });
    }

    on(event: string, listener: () => void) {
      this.listeners[event] = listener;
      return this;
    }
  }
}));

import {
  BullWalletSyncQueue,
  createWalletSyncWorker
} from "../../src/infrastructure/queue/bull-wallet-sync.queue";
import type { SyncOutcome, WalletSyncService } from "../../src/wallet/engine/wallet-sync.service";

describe("BullWalletSyncQueue.enqueueMemberSync", () => {
  beforeEach(() => {
    fake.adds.length = 0;
    fake.constructed.length = 0;
    fake.addError = null;
    fake.workers.length = 0;
    fake.queuesClosed = 0;
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

  it("adds no delay by default, so every existing caller behaves as before", async () => {
    const queue = new BullWalletSyncQueue("redis://localhost:6379");

    await queue.enqueueMemberSync("member-1");
    await queue.enqueueMemberSync("member-1", 0);

    for (const call of fake.adds) expect(call.opts?.delay).toBeUndefined();
  });

  it("passes a delay on to BullMQ when one is asked for", async () => {
    const queue = new BullWalletSyncQueue("redis://localhost:6379");

    await queue.enqueueMemberSync("member-1", 5_000);

    expect(fake.adds[0]?.opts).toEqual({ delay: 5_000 });
  });
});

describe("createWalletSyncWorker follow-up", () => {
  const MEMBER = "member-1";

  const workerFor = (result: { outcomes: SyncOutcome[]; stale: boolean }) => {
    const syncMemberChecked = vi.fn(async (_memberId: string) => result);
    createWalletSyncWorker("redis://localhost:6379", {
      syncMemberChecked
    } as unknown as WalletSyncService);
    const registered = fake.workers[0];
    return {
      syncMemberChecked,
      run: (data: unknown) => registered.processor({ data }),
      registered
    };
  };

  const synced: SyncOutcome[] = [{ provider: "GOOGLE", result: "synced" }];

  beforeEach(() => {
    fake.adds.length = 0;
    fake.workers.length = 0;
    fake.queuesClosed = 0;
    fake.addError = null;
  });

  it("enqueues exactly one follow-up carrying recheck: 1 when the card changed under the sync", async () => {
    const { run } = workerFor({ outcomes: synced, stale: true });

    await expect(run({ memberId: MEMBER })).resolves.toEqual(synced);

    expect(fake.adds).toHaveLength(1);
    expect(fake.adds[0].data).toEqual({ memberId: MEMBER, recheck: 1 });
    // Like every other wallet job: no id derived from the member, no deduplication.
    expect(fake.adds[0].opts?.jobId).toBeUndefined();
    expect(fake.adds[0].opts?.deduplication).toBeUndefined();
  });

  it("carries the chain depth forward", async () => {
    const { run } = workerFor({ outcomes: synced, stale: true });

    await run({ memberId: MEMBER, recheck: 2 });

    expect(fake.adds.map((call) => call.data)).toEqual([{ memberId: MEMBER, recheck: 3 }]);
  });

  it("stops the chain at 3 re-checks and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { run } = workerFor({ outcomes: synced, stale: true });

    await expect(run({ memberId: MEMBER, recheck: 3 })).resolves.toEqual(synced);

    expect(fake.adds).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `[wallet] sync for member ${MEMBER} still changing after 3 re-checks`
    );
  });

  it("enqueues nothing when the sync was not stale", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { run } = workerFor({ outcomes: synced, stale: false });

    await run({ memberId: MEMBER });
    await run({ memberId: MEMBER, recheck: 3 });

    expect(fake.adds).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("still fails the job for a failed provider, and enqueues no follow-up for it", async () => {
    const { run } = workerFor({
      outcomes: [{ provider: "APPLE", result: "failed", cause: new Error("nope") }],
      stale: true
    });

    await expect(run({ memberId: MEMBER })).rejects.toThrow(
      /wallet sync failed for member-1: APPLE/
    );
    expect(fake.adds).toHaveLength(0);
  });

  it("never turns a good sync into a failure because the follow-up could not be added", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { run } = workerFor({ outcomes: synced, stale: true });
    fake.addError = new Error("redis is down");

    await expect(run({ memberId: MEMBER })).resolves.toEqual(synced);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("closes the follow-up queue when the worker closes", () => {
    const { registered } = workerFor({ outcomes: synced, stale: false });

    registered.listeners.closed?.();

    expect(fake.queuesClosed).toBe(1);
  });
});
