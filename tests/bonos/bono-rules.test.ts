import { describe, expect, it } from "vitest";

import {
  bonoOutcome,
  nextBonoSession,
  remainingAfterSession,
  sessionFits,
  statusAfterSession
} from "../../src/modules/bonos/bono-rules";

describe("bono session rules", () => {
  const bono = { totalSessions: 5, sessionsUsed: 2 };

  it("the next session is one past however many are used", () => {
    expect(nextBonoSession(bono)).toBe(3);
    expect(nextBonoSession({ totalSessions: 5, sessionsUsed: 0 })).toBe(1);
  });

  it("a session outside the pack does not fit", () => {
    expect(sessionFits(bono, 1)).toBe(true);
    expect(sessionFits(bono, 5)).toBe(true);
    expect(sessionFits(bono, 0)).toBe(false);
    expect(sessionFits(bono, 6)).toBe(false);
  });

  it("completes exactly on the last session, never before", () => {
    expect(statusAfterSession(bono, 4)).toBe("ACTIVE");
    expect(statusAfterSession(bono, 5)).toBe("COMPLETED");
  });

  it("counts what remains after a session, never below zero", () => {
    expect(remainingAfterSession(bono, 3)).toBe(2);
    expect(remainingAfterSession(bono, 5)).toBe(0);
    expect(remainingAfterSession(bono, 7)).toBe(0);
  });

  it("builds the outcome the visit panel shows: session 3 of 5, two left", () => {
    expect(bonoOutcome({ id: "b-1", name: "Bono facial", ...bono }, 3)).toEqual({
      id: "b-1",
      name: "Bono facial",
      session: 3,
      total: 5,
      remaining: 2,
      status: "ACTIVE"
    });
  });
});
