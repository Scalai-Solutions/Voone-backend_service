import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { withMemberCode } from "../../src/modules/members/member-code";

const violation = (target: string[]) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: Prisma.prismaVersion.client,
    meta: { target }
  });

describe("withMemberCode", () => {
  it("hands the insert a five-character code", async () => {
    const insert = vi.fn(async (code: string) => code);

    await expect(withMemberCode(insert)).resolves.toMatch(/^[A-HJ-KM-NP-Z2-9]{5}$/);
  });

  it("tries a DIFFERENT code when the first is taken at that clinic", async () => {
    // Retrying the same code would collide forever, which is the shape of the bug this
    // asserts against rather than the retry itself.
    const insert = vi
      .fn<(code: string) => Promise<string>>()
      .mockRejectedValueOnce(violation(["clinicId", "code"]))
      .mockImplementation(async (code) => code);

    const result = await withMemberCode(insert);

    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls[1][0]).not.toBe(insert.mock.calls[0][0]);
    expect(result).toBe(insert.mock.calls[1][0]);
  });

  it("leaves a phone conflict to the caller, because it means something else", async () => {
    // A number already registered at this clinic is a re-scan at reception, and the
    // caller bumps the member's counters. Swallowing it here as a retry would insert a
    // second row for the same person on the second attempt.
    const insert = vi.fn().mockRejectedValue(violation(["clinicId", "phone"]));

    await expect(withMemberCode(insert)).rejects.toMatchObject({ code: "P2002" });
    expect(insert).toHaveBeenCalledOnce();
  });

  it("gives up rather than spinning when every code collides", async () => {
    // Behind an unauthenticated endpoint, so an unbounded loop is a way to hold a
    // connection open.
    const insert = vi.fn().mockRejectedValue(violation(["clinicId", "code"]));

    await expect(withMemberCode(insert)).rejects.toMatchObject({ code: "P2002" });
    expect(insert).toHaveBeenCalledTimes(5);
  });

  it("does not retry an unrelated database failure", async () => {
    const outage = new Prisma.PrismaClientKnownRequestError("Cannot reach database", {
      code: "P1001",
      clientVersion: Prisma.prismaVersion.client
    });
    const insert = vi.fn().mockRejectedValue(outage);

    await expect(withMemberCode(insert)).rejects.toBe(outage);
    expect(insert).toHaveBeenCalledOnce();
  });
});
