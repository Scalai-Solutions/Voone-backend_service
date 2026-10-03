export const PUSH_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const PUSH_QUOTA_MAX = 3;
export const MARKETING_PUSH_MAX = 2;

export interface NotificationQuotaUsage {
  used: number;
  remaining: number;
  resetsAt: Date | null;
}

export interface NotificationQuotaRedis {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number, withScores: "WITHSCORES"): Promise<string[]>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
}

export class InMemoryNotificationQuotaRedis implements NotificationQuotaRedis {
  private readonly sets = new Map<string, Array<{ score: number; member: string }>>();

  async zadd(key: string, score: number, member: string): Promise<void> {
    this.sets.set(key, [...(this.sets.get(key) ?? []), { score, member }]);
  }

  async zcard(key: string): Promise<number> {
    return this.sets.get(key)?.length ?? 0;
  }

  async zrange(key: string): Promise<string[]> {
    const first = [...(this.sets.get(key) ?? [])].sort((left, right) => left.score - right.score)[0];

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

export class NotificationQuotaService {
  constructor(
    private readonly redis: NotificationQuotaRedis,
    private readonly now: () => number = Date.now
  ) {}

  async canPush(objectId: string): Promise<boolean> {
    return (await this.usage(objectId)).remaining > 0;
  }

  async canMarketingPush(objectId: string): Promise<boolean> {
    const usage = await this.usage(objectId);

    return usage.used < MARKETING_PUSH_MAX && usage.remaining > 0;
  }

  async recordPush(objectId: string): Promise<void> {
    const timestamp = this.now();

    await this.trim(objectId, timestamp);
    await this.redis.zadd(this.key(objectId), timestamp, `${timestamp}:${crypto.randomUUID()}`);
  }

  async remaining(objectId: string): Promise<number> {
    return (await this.usage(objectId)).remaining;
  }

  async usage(objectId: string): Promise<NotificationQuotaUsage> {
    const timestamp = this.now();

    await this.trim(objectId, timestamp);

    const used = await this.redis.zcard(this.key(objectId));
    const oldest = await this.redis.zrange(this.key(objectId), 0, 0, "WITHSCORES");
    const oldestScore = oldest.length >= 2 ? Number(oldest[1]) : null;

    return {
      used,
      remaining: Math.max(0, PUSH_QUOTA_MAX - used),
      resetsAt: oldestScore === null ? null : new Date(oldestScore + PUSH_QUOTA_WINDOW_MS)
    };
  }

  private async trim(objectId: string, timestamp: number): Promise<void> {
    await this.redis.zremrangebyscore(this.key(objectId), 0, timestamp - PUSH_QUOTA_WINDOW_MS);
  }

  private key(objectId: string): string {
    return `wallet-notifications:${objectId}`;
  }
}