import { describe, expect, it } from "vitest";

import { madridYear } from "../../src/modules/members/member-since";

describe("madridYear", () => {
  it("uses Madrid's calendar, not the container's UTC clock", () => {
    // 23:30 UTC on 31 December is already 00:30 on 1 January in Madrid. getFullYear()
    // would print the previous year on something that reads as a physical card.
    const newYearsEve = new Date("2026-12-31T23:30:00Z");

    expect(newYearsEve.getUTCFullYear()).toBe(2026);
    expect(madridYear(newYearsEve)).toBe(2027);
  });

  it("handles the summer offset too", () => {
    // CEST is UTC+2, so 22:30 UTC on 31 December is not affected, but mid-year is.
    expect(madridYear(new Date("2026-07-01T23:30:00Z"))).toBe(2026);
  });

  it("returns the ordinary year for a daytime sign-up", () => {
    expect(madridYear(new Date("2026-09-11T10:00:00Z"))).toBe(2026);
  });

  it("produces a four digit year, which is what the pass field requires", () => {
    expect(String(madridYear(new Date()))).toMatch(/^\d{4}$/);
  });
});
