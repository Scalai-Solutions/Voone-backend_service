import { afterEach, describe, expect, it, vi } from "vitest";

import { startBirthdayNotificationCron } from "../../src/modules/notifications/birthday-cron";
import type { NotificationService } from "../../src/modules/notifications/notification.service";
import {
  EXPIRED_REWARDS_LOOKBACK_HOURS,
  EXPIRED_REWARDS_MAX_MEMBERS,
  syncMembersWithExpiredRewards
} from "../../src/modules/wallet-refresh/expired-rewards-sync";

const NOW = new Date("2026-10-27T07:00:00Z");

const fakePrisma = (rows: Array<{ memberId: string }>) => {
  const findMany = vi.fn(async () => rows);

  return { prisma: { memberReward: { findMany } } as never, findMany };
};

const queueThat = (enqueued: Array<[string, number | undefined]>) => ({
  enqueueMemberSync: async (id: string, delay?: number) => void enqueued.push([id, delay]),
  close: async () => undefined
});

afterEach(() => {
  vi.useRealTimers();
});

describe("syncMembersWithExpiredRewards", () => {
  it("looks for unredeemed rewards that expired in the last 26 hours, one row per member, capped", async () => {
    const { prisma, findMany } = fakePrisma([]);

    await syncMembersWithExpiredRewards({ prisma, syncQueue: queueThat([]), now: () => NOW });

    expect(EXPIRED_REWARDS_LOOKBACK_HOURS).toBe(26);
    expect(EXPIRED_REWARDS_MAX_MEMBERS).toBe(500);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        redeemedAt: null,
        expiresAt: { gt: new Date("2026-10-26T05:00:00Z"), lte: NOW },
        member: { erasedAt: null }
      },
      distinct: ["memberId"],
      select: { memberId: true },
      orderBy: { memberId: "asc" },
      take: 500
    });
  });

  it("queues one card sync per member and returns how many", async () => {
    const { prisma } = fakePrisma([{ memberId: "m1" }, { memberId: "m2" }]);
    const enqueued: Array<[string, number | undefined]> = [];

    const count = await syncMembersWithExpiredRewards({
      prisma,
      syncQueue: queueThat(enqueued),
      now: () => NOW
    });

    expect(count).toBe(2);
    expect(enqueued.map(([id]) => id)).toEqual(["m1", "m2"]);
  });

  it("logs the count only, never a member", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { prisma } = fakePrisma([{ memberId: "member-secret-id" }]);

    await syncMembersWithExpiredRewards({ prisma, syncQueue: queueThat([]), now: () => NOW });

    expect(JSON.stringify(info.mock.calls)).toContain("1");
    expect(JSON.stringify(info.mock.calls)).not.toContain("member-secret-id");
    info.mockRestore();
  });

  it("does nothing when wallets are not configured", async () => {
    const { prisma, findMany } = fakePrisma([{ memberId: "m1" }]);

    expect(await syncMembersWithExpiredRewards({ prisma, syncQueue: null, now: () => NOW })).toBe(
      0
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prisma = {
      memberReward: {
        findMany: async () => {
          throw new Error("db down");
        }
      }
    } as never;

    await expect(
      syncMembersWithExpiredRewards({ prisma, syncQueue: queueThat([]), now: () => NOW })
    ).resolves.toBe(0);
    error.mockRestore();
  });
});

describe("the daily cron", () => {
  const notifications = {
    runBirthdayAutomations: vi.fn(async () => ({})),
    runBonoReminderAutomations: vi.fn(async () => ({}))
  } as unknown as NotificationService;
  const schedule = { timeZone: "Europe/Madrid", hour: 9, minute: 0, frequencyMinutes: 1440 };

  it("runs the expired-rewards sync on its daily tick, and a failure there does not stop the cron", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T06:00:00Z"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const daily = vi.fn(async () => {
      throw new Error("sync failed");
    });

    const cron = startBirthdayNotificationCron(notifications, schedule, daily);

    // 09:00 Madrid is 08:00 UTC at the end of October (CET).
    await vi.advanceTimersByTimeAsync(121 * 60_000);
    expect(daily).toHaveBeenCalledTimes(1);

    // The next day's tick is still scheduled.
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(daily).toHaveBeenCalledTimes(2);

    cron.stop();
    error.mockRestore();
    info.mockRestore();
  });
});
