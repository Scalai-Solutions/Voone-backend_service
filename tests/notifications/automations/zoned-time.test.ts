import { describe, expect, it } from "vitest";

import { nextDailyRun, zonedDate } from "../../../src/common/utils/zoned-time";

const madrid9 = { timeZone: "Europe/Madrid", hour: 9, minute: 0 };

describe("nextDailyRun", () => {
  it("runs today at 09:00 Madrid when that has not passed (CEST, UTC+2)", () => {
    expect(nextDailyRun(new Date("2026-10-17T05:00:00Z"), madrid9).toISOString()).toBe(
      "2026-10-17T07:00:00.000Z"
    );
  });

  it("moves to tomorrow once 09:00 has passed", () => {
    expect(nextDailyRun(new Date("2026-10-17T07:30:00Z"), madrid9).toISOString()).toBe(
      "2026-10-18T07:00:00.000Z"
    );
  });

  it("follows the clock change at the end of summer time (25 Oct 2026)", () => {
    // Saturday 24th is still CEST (UTC+2); from Sunday 25th Madrid is CET (UTC+1).
    expect(nextDailyRun(new Date("2026-10-24T07:30:00Z"), madrid9).toISOString()).toBe(
      "2026-10-25T08:00:00.000Z"
    );
  });

  it("allows the time to be changed", () => {
    expect(
      nextDailyRun(new Date("2026-10-17T08:30:00Z"), {
        ...madrid9,
        hour: 11,
        minute: 15
      }).toISOString()
    ).toBe("2026-10-17T09:15:00.000Z");
  });
});

describe("zonedDate", () => {
  it("is the calendar date in the zone, not in UTC", () => {
    // 23:30 UTC on the 31st is already 00:30 on 1 November in Madrid.
    expect(zonedDate(new Date("2026-10-31T23:30:00Z"), "Europe/Madrid")).toMatchObject({
      dateKey: "2026-11-01",
      month: 11,
      day: 1
    });
  });
});
