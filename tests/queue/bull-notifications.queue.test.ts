import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  adds: [] as Array<{ name: string; opts: Record<string, unknown> }>,
  removed: [] as string[],
  states: new Map<string, string>()
}));

vi.mock("bullmq", () => ({
  Queue: class {
    async getJob(id: string) {
      const state = fake.states.get(id);

      return state
        ? {
            getState: async () => state,
            remove: async () => {
              fake.removed.push(id);
            }
          }
        : undefined;
    }

    async add(name: string, _data: unknown, opts: Record<string, unknown>) {
      fake.adds.push({ name, opts });
    }

    async close() {}
  },
  Worker: class {}
}));

import { BullNotificationQueue } from "../../src/infrastructure/queue/bull-notifications.queue";

describe("BullNotificationQueue.enqueueDelivery", () => {
  beforeEach(() => {
    fake.adds.length = 0;
    fake.removed.length = 0;
    fake.states.clear();
  });

  it.each(["failed", "completed"])(
    "clears a %s job under the same id so the re-enqueue is not ignored",
    async (state) => {
      fake.states.set("delivery-d-1", state);

      await new BullNotificationQueue("redis://localhost:6379").enqueueDelivery("d-1");

      expect(fake.removed).toEqual(["delivery-d-1"]);
      expect(fake.adds).toHaveLength(1);
      expect(fake.adds[0]?.opts.jobId).toBe("delivery-d-1");
    }
  );

  it.each(["waiting", "delayed", "active"])(
    "keeps a %s job, which is the deduplication the id exists for",
    async (state) => {
      fake.states.set("delivery-d-1", state);

      await new BullNotificationQueue("redis://localhost:6379").enqueueDelivery("d-1");

      expect(fake.removed).toEqual([]);
      expect(fake.adds).toHaveLength(1);
    }
  );

  it("adds normally when there is no earlier job", async () => {
    await new BullNotificationQueue("redis://localhost:6379").enqueueDelivery("d-2", 500);

    expect(fake.removed).toEqual([]);
    expect(fake.adds[0]?.opts).toEqual({ jobId: "delivery-d-2", delay: 500 });
  });
});
