import { describe, expect, it } from "vitest";

import { nextBirthdayCronRun } from "../../src/modules/notifications/birthday-cron";

describe("birthday notification cron", () => {
  it("schedules the next run for 9am in Madrid when it has not run today", () => {
    const next = nextBirthdayCronRun(new Date("2026-10-17T06:30:00.000Z"));

    expect(next.toISOString()).toBe("2026-10-17T07:00:00.000Z");
  });

  it("moves to tomorrow after 9am in Madrid", () => {
    const next = nextBirthdayCronRun(new Date("2026-10-17T08:30:00.000Z"));

    expect(next.toISOString()).toBe("2026-10-18T07:00:00.000Z");
  });
});
