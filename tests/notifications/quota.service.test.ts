import { describe, expect, it } from "vitest";

import {
  MARKETING_PUSH_MAX,
  NotificationQuotaService,
  PUSH_QUOTA_MAX,
  PUSH_QUOTA_WINDOW_MS,
  type NotificationQuotaRedis
} from "../../src/modules/notifications/quota.service";

class FakeRedis implements NotificationQuotaRedis {
  readonly sets = new Map<string, Array<{ score: number; member: string }>>();

  async zadd(key: string, score: number, member: string): Promise<void> {
    this.sets.set(key, [...(this.sets.get(key) ?? []), { score, member }]);
  }

  async zcard(key: string): Promise<number> {
    return this.sets.get(key)?.length ?? 0;
  }

  async zrange(key: string): Promise<string[]> {
    const first = [...(this.sets.get(key) ?? [])].sort((a, b) => a.score - b.score)[0];

    return first ? [first.member, String(first.score)] : [];
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<void> {
    const lower = Number(min);
    const upper = Number(max);

    this.sets.set(
      key,
      (this.sets.get(key) ?? []).filter((entry) => entry.score < lower || entry.score > upper)
    );
  }
}

describe("NotificationQuotaService", () => {
  it("tracks the rolling 24 hour Google push budget", async () => {
    let now = 1_000;
    const quota = new NotificationQuotaService(new FakeRedis(), () => now);

    for (let index = 0; index < PUSH_QUOTA_MAX; index += 1) {
      expect(await quota.canPush("object-1")).toBe(true);
      await quota.recordPush("object-1");
    }

    expect(await quota.canPush("object-1")).toBe(false);
    expect(await quota.remaining("object-1")).toBe(0);

    now += PUSH_QUOTA_WINDOW_MS + 1;

    expect(await quota.canPush("object-1")).toBe(true);
    expect(await quota.remaining("object-1")).toBe(PUSH_QUOTA_MAX);
  });

  it("reserves one slot for transactional points and tier pushes", async () => {
    const quota = new NotificationQuotaService(new FakeRedis(), () => 1_000);

    for (let index = 0; index < MARKETING_PUSH_MAX; index += 1) {
      expect(await quota.canMarketingPush("object-1")).toBe(true);
      await quota.recordPush("object-1");
    }

    expect(await quota.canPush("object-1")).toBe(true);
    expect(await quota.canMarketingPush("object-1")).toBe(false);
  });
});
