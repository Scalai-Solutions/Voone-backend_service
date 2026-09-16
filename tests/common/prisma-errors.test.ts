import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { isUniqueViolation } from "../../src/common/utils/prisma-errors";

const uniqueViolation = (target: string | string[] = ["clinicId", "phone"]) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: Prisma.prismaVersion.client,
    meta: { target }
  });

describe("isUniqueViolation", () => {
  it("recognizes a real P2002 from the client", () => {
    expect(isUniqueViolation(uniqueViolation())).toBe(true);
  });

  it("matches on the constrained fields when asked", () => {
    expect(isUniqueViolation(uniqueViolation(), ["clinicId", "phone"])).toBe(true);
    expect(isUniqueViolation(uniqueViolation(), ["phone", "clinicId"])).toBe(true);
    expect(isUniqueViolation(uniqueViolation(["slug"]), ["clinicId", "phone"])).toBe(false);
  });

  it("handles meta.target arriving as a named constraint string, not a field list", () => {
    // A false negative here makes the service rethrow, turning an ordinary re-scan at
    // reception into a 500, so the constraint name must satisfy a field match too.
    expect(isUniqueViolation(uniqueViolation("Member_clinicId_phone_key"))).toBe(true);
    expect(
      isUniqueViolation(uniqueViolation("Member_clinicId_phone_key"), ["clinicId", "phone"])
    ).toBe(true);
    expect(isUniqueViolation(uniqueViolation("Clinic_slug_key"), ["clinicId", "phone"])).toBe(
      false
    );
  });

  it("fails safe when there is no target detail at all", () => {
    // The caller re-reads the row and rethrows if it is absent, so claiming the match
    // is recoverable where denying it is a hard 500.
    expect(isUniqueViolation({ code: "P2002" }, ["clinicId", "phone"])).toBe(true);
  });

  it("is structural, so it survives two copies of @prisma/client in one tree", () => {
    // instanceof fails silently across a module boundary; a duck-typed error must match.
    expect(isUniqueViolation({ code: "P2002", meta: { target: ["clinicId", "phone"] } })).toBe(
      true
    );
  });

  it("does not swallow other database failures", () => {
    expect(isUniqueViolation({ code: "P2003" })).toBe(false);
    expect(isUniqueViolation({ code: "P1001" })).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("P2002")).toBe(false);
  });
});
