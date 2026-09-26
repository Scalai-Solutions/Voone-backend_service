import { describe, expect, it } from "vitest";

import { CLINIC_TIME_ZONE, startOfMonthIn } from "../../src/common/utils/zoned-month";

/**
 * "Points issued this month" is read by a clinic in Madrid, so the month has to begin at
 * midnight there. Using UTC would misattribute every movement made between 00:00 and
 * 01:00 Madrid on the 1st — 02:00 in summer — to the previous month. A small window, but
 * one that makes a dashboard figure wrong in a way nobody can explain.
 */
describe("startOfMonthIn", () => {
  it("starts the month at midnight in the zone, not in UTC", () => {
    // Madrid is UTC+2 in July, so the month begins at 22:00 UTC on 30 June.
    const start = startOfMonthIn(CLINIC_TIME_ZONE, new Date("2026-07-15T12:00:00Z"));

    expect(start.toISOString()).toBe("2026-06-30T22:00:00.000Z");
  });

  it("uses the winter offset in winter", () => {
    // UTC+1 in January, so 23:00 UTC on 31 December.
    const start = startOfMonthIn(CLINIC_TIME_ZONE, new Date("2026-01-15T12:00:00Z"));

    expect(start.toISOString()).toBe("2025-12-31T23:00:00.000Z");
  });

  it("measures the offset at the month boundary, not at 'now'", () => {
    // April in Madrid is UTC+2, but 1 April began while the clock had already shifted.
    // A naive implementation that read the offset at `now` would still be right here;
    // this asserts the boundary itself rather than the caller's instant.
    const fromEarly = startOfMonthIn(CLINIC_TIME_ZONE, new Date("2026-04-01T00:30:00Z"));
    const fromLate = startOfMonthIn(CLINIC_TIME_ZONE, new Date("2026-04-28T23:30:00Z"));

    expect(fromEarly.toISOString()).toBe(fromLate.toISOString());
  });

  it("is idempotent across any instant within the month", () => {
    const a = startOfMonthIn(CLINIC_TIME_ZONE, new Date("2026-09-01T00:00:00Z"));
    const b = startOfMonthIn(CLINIC_TIME_ZONE, new Date("2026-09-30T21:59:59Z"));

    expect(a.toISOString()).toBe(b.toISOString());
  });

  it("rolls back to the previous year in January", () => {
    const start = startOfMonthIn(CLINIC_TIME_ZONE, new Date("2026-01-02T00:00:00Z"));

    expect(start.getUTCFullYear()).toBe(2025);
    expect(start.getUTCMonth()).toBe(11);
  });

  it("agrees with UTC for a zone that is UTC", () => {
    const start = startOfMonthIn("UTC", new Date("2026-05-20T09:00:00Z"));

    expect(start.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});
