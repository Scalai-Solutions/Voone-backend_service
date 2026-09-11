import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { ClinicNotFoundError } from "../../src/common/errors/membership.errors";
import { findClinicBySlug, toPublicClinic } from "../../src/modules/clinics/clinic.service";

const AUREA = {
  id: "c1",
  slug: "aurea",
  name: "AURÉA",
  tagline: "CLINIC CLUB",
  privacyPolicyVersion: "v1",
  isActive: true,
  createdAt: new Date("2026-01-01T00:00:00Z")
};

const db = (findUnique: ReturnType<typeof vi.fn>) =>
  ({ clinic: { findUnique } }) as unknown as PrismaClient;

describe("findClinicBySlug", () => {
  it("returns the clinic a QR poster points at", async () => {
    await expect(findClinicBySlug(db(vi.fn().mockResolvedValue(AUREA)), "aurea")).resolves.toBe(
      AUREA
    );
  });

  it("throws a 404 for a slug that is not seeded", async () => {
    const attempt = findClinicBySlug(db(vi.fn().mockResolvedValue(null)), "no-existe");

    await expect(attempt).rejects.toThrow(ClinicNotFoundError);
    await expect(attempt).rejects.toMatchObject({ statusCode: 404, expose: true });
  });

  it("treats an inactive clinic as absent, so a churned poster stops minting members", async () => {
    const findUnique = vi.fn().mockResolvedValue({ ...AUREA, isActive: false });

    // 404 rather than 403: the response must not confirm the clinic ever existed.
    await expect(findClinicBySlug(db(findUnique), "aurea")).rejects.toMatchObject({
      statusCode: 404
    });
  });

  it("rejects a malformed slug without querying at all", async () => {
    const findUnique = vi.fn();

    for (const slug of ["../../etc/passwd", "AUREA", "aurea/", "аurea", ""]) {
      await expect(findClinicBySlug(db(findUnique), slug), slug).rejects.toThrow(
        ClinicNotFoundError
      );
    }

    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("toPublicClinic", () => {
  it("exposes only what the form needs to render itself", () => {
    expect(toPublicClinic(AUREA)).toEqual({
      slug: "aurea",
      name: "AURÉA",
      tagline: "CLINIC CLUB",
      privacyPolicyVersion: "v1"
    });
  });

  it("never leaks the internal id, which invites the frontend to depend on it", () => {
    expect(toPublicClinic(AUREA)).not.toHaveProperty("id");
    expect(toPublicClinic(AUREA)).not.toHaveProperty("isActive");
    expect(toPublicClinic(AUREA)).not.toHaveProperty("createdAt");
  });
});
