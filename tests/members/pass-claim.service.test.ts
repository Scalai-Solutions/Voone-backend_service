import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { CLAIM_TTL_MS, PrismaPassClaimService } from "../../src/modules/members/pass-claim.service";

interface Row {
  id: string;
  tokenHash: string;
  memberId: string;
  expiresAt: Date;
  claimedAt: Date | null;
}

/** In-memory stand-in that keeps the one invariant that matters: tokenHash is unique. */
const fakePrisma = () => {
  const rows: Row[] = [];

  return {
    rows,
    passClaim: {
      create: async ({ data }: { data: Omit<Row, "id" | "claimedAt"> }) => {
        if (rows.some((r) => r.tokenHash === data.tokenHash)) {
          throw new Error("unique violation");
        }

        const row: Row = { id: `c${rows.length}`, claimedAt: null, ...data };
        rows.push(row);

        return row;
      },
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        rows.find((r) => r.tokenHash === where.tokenHash) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id);

        if (row) Object.assign(row, data);

        return row;
      },
      deleteMany: async ({ where }: { where: { expiresAt: { lt: Date } } }) => {
        const doomed = rows.filter((r) => r.expiresAt.getTime() < where.expiresAt.lt.getTime());
        doomed.forEach((r) => rows.splice(rows.indexOf(r), 1));

        return { count: doomed.length };
      }
    }
  };
};

const build = () => {
  const prisma = fakePrisma();

  return { prisma, service: new PrismaPassClaimService(prisma as never) };
};

const NOW = new Date("2026-09-26T12:00:00Z");

describe("PrismaPassClaimService", () => {
  it("resolves a fresh token to its member", async () => {
    const { service } = build();

    const token = await service.mint("member-1", NOW);

    expect(await service.resolve(token, NOW)).toBe("member-1");
  });

  it("never stores the token itself", async () => {
    // A claim URL ends up in browser history and in whatever the phone syncs. The row
    // must not be enough to mint a pass if the database leaks.
    const { prisma, service } = build();

    const token = await service.mint("member-1", NOW);

    expect(prisma.rows[0].tokenHash).not.toBe(token);
    expect(prisma.rows[0].tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("issues a different token every time", async () => {
    const { service } = build();

    const a = await service.mint("member-1", NOW);
    const b = await service.mint("member-1", NOW);

    expect(a).not.toBe(b);
  });

  it("refuses a token past its window", async () => {
    const { service } = build();

    const token = await service.mint("member-1", NOW);
    const late = new Date(NOW.getTime() + CLAIM_TTL_MS + 1);

    expect(await service.resolve(token, late)).toBeNull();
  });

  it("accepts one on the last millisecond of the window", async () => {
    const { service } = build();

    const token = await service.mint("member-1", NOW);
    const edge = new Date(NOW.getTime() + CLAIM_TTL_MS - 1);

    expect(await service.resolve(token, edge)).toBe("member-1");
  });

  it("answers null for a token nobody issued", async () => {
    const { service } = build();

    expect(await service.resolve("not-a-real-token", NOW)).toBeNull();
  });

  it("still works on a second tap, because a failed Add must be retryable", async () => {
    // Recorded, not enforced as single-use: re-submitting the sign-up form would answer
    // "already a member" and hand back no new token, so a strict single use would
    // strand a member whose first tap failed.
    const { service } = build();

    const token = await service.mint("member-1", NOW);

    expect(await service.resolve(token, NOW)).toBe("member-1");
    expect(await service.resolve(token, NOW)).toBe("member-1");
  });

  it("records when it was first claimed, and does not move it afterwards", async () => {
    const { prisma, service } = build();

    const token = await service.mint("member-1", NOW);
    await service.resolve(token, NOW);
    const first = prisma.rows[0].claimedAt;

    await service.resolve(token, new Date(NOW.getTime() + 60_000));

    expect(first).toEqual(NOW);
    expect(prisma.rows[0].claimedAt).toEqual(NOW);
  });

  it("sweeps expired rows and leaves live ones", async () => {
    const { prisma, service } = build();

    await service.mint("old", new Date(NOW.getTime() - CLAIM_TTL_MS - 1));
    await service.mint("new", NOW);

    expect(await service.sweep(NOW)).toBe(1);
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].memberId).toBe("new");
  });
});
