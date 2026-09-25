import { PointsTransactionKind } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { projectBalance, type PointsMovement } from "../../src/modules/points/points-balance";
import type {
  MemberPointsCache,
  PointsEntry,
  PointsLedgerRepository,
  SpendOutcome
} from "../../src/modules/points/points-ledger.repository";
import { InsufficientPointsError, PointsService } from "../../src/modules/points/points.service";
import type { TierDefinition } from "../../src/modules/points/tier-engine";

const MEMBER = "member-1";
const CLINIC = "clinic-1";

const SCALE: TierDefinition[] = [
  { code: "bronze", label: "Bronce", minLifetimePoints: 0 },
  { code: "silver", label: "Plata", minLifetimePoints: 500 },
  { code: "gold", label: "Oro", minLifetimePoints: 2000 }
];

/**
 * An in-memory ledger that keeps the invariants the real one enforces in the database:
 * the idempotency key is unique, and a spend cannot take the balance below zero. A
 * double that allowed either would let the service's tests pass against behaviour
 * production does not have.
 */
class Ledger implements PointsLedgerRepository {
  rows: PointsEntry[] = [];
  scale: TierDefinition[] = SCALE;

  async append(entry: PointsEntry) {
    if (this.rows.some((row) => row.idempotencyKey === entry.idempotencyKey)) {
      return { applied: false };
    }

    this.rows.push(entry);
    return { applied: true };
  }

  async appendSpend(entry: PointsEntry): Promise<SpendOutcome> {
    if (this.rows.some((row) => row.idempotencyKey === entry.idempotencyKey)) {
      return { outcome: "duplicate" };
    }

    const spendable = this.movements().reduce((sum, m) => sum + m.points, 0);

    if (spendable + entry.points < 0) {
      return { outcome: "insufficient", spendable };
    }

    this.rows.push(entry);
    return { outcome: "applied" };
  }

  async balanceFor() {
    return projectBalance(this.movements());
  }

  async tierScaleFor() {
    return this.scale;
  }

  private movements(): PointsMovement[] {
    return this.rows.map((row) => ({ points: row.points, kind: row.kind }));
  }
}

class Cache implements MemberPointsCache {
  writes: { memberId: string; spendable: number; tierCode: string | null }[] = [];

  async write(memberId: string, spendable: number, tierCode: string | null) {
    this.writes.push({ memberId, spendable, tierCode });
  }

  get last() {
    return this.writes[this.writes.length - 1];
  }
}

describe("PointsService", () => {
  let ledger: Ledger;
  let cache: Cache;
  let synced: string[];
  let service: PointsService;

  beforeEach(() => {
    ledger = new Ledger();
    cache = new Cache();
    synced = [];
    service = new PointsService(ledger, cache, {
      enqueueMemberSync: async (memberId: string) => {
        synced.push(memberId);
      },
      close: async () => {}
    });
  });

  const credit = (points: number, idempotencyKey: string) =>
    service.credit({
      memberId: MEMBER,
      clinicId: CLINIC,
      points,
      kind: PointsTransactionKind.EARN,
      idempotencyKey
    });

  const redeem = (points: number, idempotencyKey: string) =>
    service.redeem({ memberId: MEMBER, clinicId: CLINIC, points, idempotencyKey });

  describe("crediting", () => {
    it("records the movement and reports both balances", async () => {
      const outcome = await credit(600, "visit-1");

      expect(outcome.applied).toBe(true);
      expect(outcome.balance).toEqual({ spendable: 600, lifetime: 600 });
    });

    it("resolves the tier from lifetime points", async () => {
      await credit(2100, "visit-1");

      expect(cache.last).toEqual({ memberId: MEMBER, spendable: 2100, tierCode: "gold" });
    });

    it("asks the wallets to catch up", async () => {
      await credit(100, "visit-1");

      expect(synced).toEqual([MEMBER]);
    });

    it("applies the sign itself, so a caller cannot credit a negative", async () => {
      await expect(credit(-50, "visit-1")).rejects.toBeInstanceOf(RangeError);
      expect(ledger.rows).toHaveLength(0);
    });

    it("rejects a fractional amount before it reaches the database CHECK", async () => {
      await expect(credit(1.5, "visit-1")).rejects.toBeInstanceOf(RangeError);
    });
  });

  describe("idempotency", () => {
    it("does not move points twice for the same operation", async () => {
      await credit(100, "same-key");
      const second = await credit(100, "same-key");

      expect(second.applied).toBe(false);
      expect(second.balance.spendable).toBe(100);
      expect(ledger.rows).toHaveLength(1);
    });

    it("still refreshes the cache and the wallet on a duplicate", async () => {
      // A retry usually means the first attempt did not visibly finish, and the likeliest
      // reason is that this step failed. Repeating it is how a member whose card is stuck
      // on an old balance gets unstuck.
      await credit(100, "same-key");
      synced.length = 0;

      await credit(100, "same-key");

      expect(synced).toEqual([MEMBER]);
    });
  });

  describe("redeeming", () => {
    it("spends what the member has", async () => {
      await credit(500, "visit-1");

      const outcome = await redeem(200, "reward-1");

      expect(outcome.balance).toEqual({ spendable: 300, lifetime: 500 });
    });

    it("does not demote a member who spends", async () => {
      // The whole reason lifetime and spendable are separate.
      await credit(2100, "visit-1");
      await redeem(2000, "reward-1");

      expect(cache.last.tierCode).toBe("gold");
      expect(cache.last.spendable).toBe(100);
    });

    it("refuses to overspend, and says by how much", async () => {
      await credit(100, "visit-1");

      await expect(redeem(150, "reward-1")).rejects.toMatchObject({
        name: "InsufficientPointsError",
        requested: 150,
        spendable: 100
      });
      expect(ledger.rows).toHaveLength(1);
    });

    it("allows spending down to exactly zero", async () => {
      await credit(100, "visit-1");

      const outcome = await redeem(100, "reward-1");

      expect(outcome.balance.spendable).toBe(0);
    });

    it("treats a repeated redemption as the one that already happened", async () => {
      await credit(500, "visit-1");
      await redeem(200, "reward-1");
      const again = await redeem(200, "reward-1");

      // The double-redemption guard. A double tap at reception must not charge twice.
      expect(again.applied).toBe(false);
      expect(again.balance.spendable).toBe(300);
    });
  });

  describe("clawing back a mistake", () => {
    it("reduces the tier as well as the balance", async () => {
      // The case that made lifetime kind-based: a mistaken credit must be fully undoable,
      // not just undoable for spending.
      await service.credit({
        memberId: MEMBER,
        clinicId: CLINIC,
        points: 1_000_000,
        kind: PointsTransactionKind.ADJUSTMENT,
        idempotencyKey: "oops"
      });
      expect(cache.last.tierCode).toBe("gold");

      await service.clawBack({
        memberId: MEMBER,
        clinicId: CLINIC,
        points: 1_000_000,
        idempotencyKey: "undo-oops"
      });

      expect(cache.last).toEqual({ memberId: MEMBER, spendable: 0, tierCode: "bronze" });
    });
  });

  describe("tier scale resolution", () => {
    it("writes no tier when the clinic's scale reaches nobody", async () => {
      ledger.scale = [{ code: "gold", label: "Oro", minLifetimePoints: 2000 }];

      await credit(10, "visit-1");

      expect(cache.last.tierCode).toBeNull();
    });

    it("uses whatever scale the clinic resolves to", async () => {
      ledger.scale = [{ code: "vip", label: "VIP", minLifetimePoints: 5 }];

      await credit(10, "visit-1");

      expect(cache.last.tierCode).toBe("vip");
    });
  });
});

describe("InsufficientPointsError", () => {
  it("says what was asked for and what was there", () => {
    const error = new InsufficientPointsError(150, 100);

    expect(error.message).toContain("150");
    expect(error.message).toContain("100");
  });
});
