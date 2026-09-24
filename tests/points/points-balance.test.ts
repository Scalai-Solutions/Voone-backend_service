import { PointsTransactionKind } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { projectBalance, ZERO_BALANCE } from "../../src/modules/points/points-balance";

const earn = (points: number) => ({ points, kind: PointsTransactionKind.EARN });
const spend = (points: number) => ({
  points: -Math.abs(points),
  kind: PointsTransactionKind.REDEEM
});
const expire = (points: number) => ({
  points: -Math.abs(points),
  kind: PointsTransactionKind.EXPIRY
});
const adjust = (points: number) => ({ points, kind: PointsTransactionKind.ADJUSTMENT });

describe("projectBalance", () => {
  it("is zero for a member who has never transacted", () => {
    expect(projectBalance([])).toEqual(ZERO_BALANCE);
  });

  it("sums earns into both balances", () => {
    expect(projectBalance([earn(100), earn(250)])).toEqual({ spendable: 350, lifetime: 350 });
  });

  it("spending reduces what is spendable and leaves lifetime alone", () => {
    // The whole reason the two exist. A member who reaches a tier and then uses it does
    // not stop holding it.
    expect(projectBalance([earn(2100), spend(2000)])).toEqual({
      spendable: 100,
      lifetime: 2100
    });
  });

  it("gives the same answer whatever order the ledger is read in", () => {
    const movements = [earn(100), spend(30), earn(70), spend(10)];
    const reversed = [...movements].reverse();

    // Order-independence is what makes the cached columns on Member safe to recompute at
    // any moment, including halfway through a backfill.
    expect(projectBalance(movements)).toEqual(projectBalance(reversed));
  });

  it("reports a negative spendable balance rather than hiding it", () => {
    // Should never happen — the credit service refuses to overspend — so if it does, the
    // number must be visible. Clamping at zero would turn a ledger bug into a silent one.
    expect(projectBalance([earn(10), spend(50)]).spendable).toBe(-40);
  });

  it("an expiry reduces spendable without erasing what was earned", () => {
    // A tier records what the member achieved, not what they still hold.
    expect(projectBalance([earn(500), expire(500)])).toEqual({ spendable: 0, lifetime: 500 });
  });

  it("a clawback adjustment DOES reduce lifetime, so a mistake can be undone", () => {
    // The case that made this kind-based rather than sign-based: a staff member credits
    // a million points by mistake. Summing positive movements would restore the
    // spendable balance and leave the member at the top tier for good.
    expect(projectBalance([adjust(1_000_000), adjust(-1_000_000)])).toEqual({
      spendable: 0,
      lifetime: 0
    });
  });

  it("a positive adjustment counts, because goodwill points are still earned", () => {
    expect(projectBalance([adjust(250)]).lifetime).toBe(250);
  });
});
