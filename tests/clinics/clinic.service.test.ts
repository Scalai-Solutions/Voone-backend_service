import type { Clinic, ClinicTemplate, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { ClinicNotFoundError } from "../../src/common/errors/membership.errors";
import { findClinicBySlug, toPublicClinic } from "../../src/modules/clinics/clinic.service";

const AUREA = {
  id: "c1",
  slug: "aurea",
  name: "AURÉA",
  addressLine: "Calle de Serrano 21",
  pincode: "28001",
  privacyPolicyVersion: "v1",
  isActive: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z")
} satisfies Clinic;

const TEMPLATE = {
  id: "t1",
  clinicId: "c1",
  presetId: "p1",
  programName: "AURÉA Clinic Club",
  hexBackgroundColor: "#ead0bd",
  logoUrl: null,
  heroImageUrl: null,
  pointsLabel: "Puntos",
  tierLabel: "Nivel",
  benefitsText: "Acumula puntos en cada visita.",
  infoText: "Presenta tu pase en recepción.",
  status: "ACTIVE",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z")
} satisfies ClinicTemplate;

const db = (findUnique: ReturnType<typeof vi.fn>) =>
  ({ clinic: { findUnique } }) as unknown as PrismaClient;

describe("findClinicBySlug", () => {
  it("returns the clinic a QR poster points at", async () => {
    const clinic = { ...AUREA, template: TEMPLATE };

    await expect(findClinicBySlug(db(vi.fn().mockResolvedValue(clinic)), "aurea")).resolves.toBe(
      clinic
    );
  });

  it("fetches the template in the same query, since every caller needs it", async () => {
    const findUnique = vi.fn().mockResolvedValue({ ...AUREA, template: TEMPLATE });

    await findClinicBySlug(db(findUnique), "aurea");

    expect(findUnique).toHaveBeenCalledWith({
      where: { slug: "aurea" },
      include: { template: true }
    });
  });

  it("returns a clinic that has no template, leaving the 404 to the caller", async () => {
    // The sign-up path does not need branding; only the page does. Deciding here would
    // couple registering a member to the clinic having finished its template.
    const clinic = { ...AUREA, template: null };

    await expect(
      findClinicBySlug(db(vi.fn().mockResolvedValue(clinic)), "aurea")
    ).resolves.toMatchObject({ template: null });
  });

  it("throws a 404 for a slug that is not seeded", async () => {
    const attempt = findClinicBySlug(db(vi.fn().mockResolvedValue(null)), "no-existe");

    await expect(attempt).rejects.toThrow(ClinicNotFoundError);
    await expect(attempt).rejects.toMatchObject({ statusCode: 404, expose: true });
  });

  it("treats an inactive clinic as absent, so a churned poster stops minting members", async () => {
    const findUnique = vi.fn().mockResolvedValue({ ...AUREA, isActive: false, template: TEMPLATE });

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
  it("renders the clinic's own branding, taken from its template", () => {
    expect(toPublicClinic(AUREA, TEMPLATE)).toEqual({
      slug: "aurea",
      name: "AURÉA",
      privacyPolicyVersion: "v1",
      template: {
        programName: "AURÉA Clinic Club",
        hexBackgroundColor: "#ead0bd",
        logoUrl: null,
        heroImageUrl: null,
        pointsLabel: "Puntos",
        tierLabel: "Nivel",
        benefitsText: "Acumula puntos en cada visita.",
        infoText: "Presenta tu pase en recepción."
      }
    });
  });

  it("leaks no internal or operational field", () => {
    const projected = toPublicClinic(AUREA, TEMPLATE);

    // id invites the frontend to depend on it; the rest is the clinic's own business.
    for (const field of ["id", "isActive", "createdAt", "updatedAt", "addressLine", "pincode"]) {
      expect(projected, field).not.toHaveProperty(field);
    }
    for (const field of ["id", "clinicId", "presetId", "status", "createdAt"]) {
      expect(projected.template, `template.${field}`).not.toHaveProperty(field);
    }
  });

  it("passes a PENDING template through, since status tracks wallet provisioning", () => {
    // A clinic whose wallet class has not been created yet can still take sign-ups.
    const pending = { ...TEMPLATE, status: "PENDING" } satisfies ClinicTemplate;

    expect(toPublicClinic(AUREA, pending).template.programName).toBe("AURÉA Clinic Club");
  });
});
