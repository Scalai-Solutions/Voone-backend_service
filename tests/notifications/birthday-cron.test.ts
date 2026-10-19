import { describe, expect, it } from "vitest";

import { nextBirthdayCronRun } from "../../src/modules/notifications/birthday-cron";

describe("birthday notification cron", () => {
  const defaultSchedule = {
    timeZone: "Europe/Madrid",
    hour: 9,
    minute: 0,
    frequencyMinutes: 1440
  };

  it("schedules the next run for 9am in Madrid when it has not run today", () => {
    const next = nextBirthdayCronRun(new Date("2026-10-17T06:30:00.000Z"), defaultSchedule);

    expect(next.toISOString()).toBe("2026-10-17T07:00:00.000Z");
  });

  it("moves to tomorrow after 9am in Madrid", () => {
    const next = nextBirthdayCronRun(new Date("2026-10-17T08:30:00.000Z"), defaultSchedule);

    expect(next.toISOString()).toBe("2026-10-18T07:00:00.000Z");
  });

  it("allows the daily send time to be changed", () => {
    const next = nextBirthdayCronRun(new Date("2026-10-17T08:30:00.000Z"), {
      ...defaultSchedule,
      hour: 11,
      minute: 15
    });

    expect(next.toISOString()).toBe("2026-10-17T09:15:00.000Z");
  });

  it("allows the wake-up frequency to be changed", () => {
    const next = nextBirthdayCronRun(new Date("2026-10-17T07:20:00.000Z"), {
      ...defaultSchedule,
      frequencyMinutes: 30
    });

    expect(next.toISOString()).toBe("2026-10-17T07:30:00.000Z");
  });
});
