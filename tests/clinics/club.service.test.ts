import type { Clinic, ClinicTemplate, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { ClinicNotFoundError } from "../../src/common/errors/membership.errors";
import { findClubPage } from "../../src/modules/clinics/club.service";
import { run } from "../../src/modules/onboarding/engine";
import type { Answers, CatalogItem } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import catalog from "../onboarding/reference/sapphira.catalogo.json";

const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const output = (() => {
  const result = run(catalog as CatalogItem[], ANSWERS);

  if (isEngineError(result)) throw new Error(result.error);

  return result;
})();

const TEMPLATE = {
  programName: "Club Privé",
  hexBackgroundColor: "#ead0bd",
  logoUrl: "https://cdn.example/logo.png",
  heroImageUrl: null,
  pointsLabel: "Puntos",
  tierLabel: "Nivel",
  benefitsText: "x",
  infoText: "y"
} as unknown as ClinicTemplate;

const CLINIC = {
  id: "00000000-0000-4000-8000-0000000a0001",
  slug: "sapphira",
  name: "Sapphira Privé",
  privacyPolicyVersion: "v2",
  isActive: true,
  billingName: "Razón Social SL",
  billingTaxId: "B00000000",
  contactEmail: "private@example.com",
  template: TEMPLATE
} as unknown as Clinic & { template: ClinicTemplate | null };

const db = (clinic: unknown, live: unknown) =>
  ({
    clinic: { findUnique: vi.fn().mockResolvedValue(clinic) },
    onboardingProgram: { findFirst: vi.fn().mockResolvedValue(live) }
  }) as unknown as PrismaClient;

describe("findClubPage", () => {
  it("returns the clinic's branding and its live programme's club view", async () => {
    const page = await findClubPage(db(CLINIC, { output }), "sapphira");

    expect(page.clinic.name).toBe("Sapphira Privé");
    expect(page.clinic.template.programName).toBe("Club Privé");
    expect(page.club.tiers).toHaveLength(5);
  });

  it("leaks nothing of the clinic beyond what the sign-up page already shows", async () => {
    const serialised = JSON.stringify(await findClubPage(db(CLINIC, { output }), "sapphira"));

    expect(serialised).not.toContain("Razón Social");
    expect(serialised).not.toContain("B00000000");
    expect(serialised).not.toContain("private@example.com");
  });

  it("is a 404 for an unknown clinic, an inactive one, one with no template and one with no live programme", async () => {
    await expect(findClubPage(db(null, { output }), "nope")).rejects.toBeInstanceOf(
      ClinicNotFoundError
    );
    await expect(
      findClubPage(db({ ...CLINIC, isActive: false }, { output }), "sapphira")
    ).rejects.toBeInstanceOf(ClinicNotFoundError);
    await expect(
      findClubPage(db({ ...CLINIC, template: null }, { output }), "sapphira")
    ).rejects.toBeInstanceOf(ClinicNotFoundError);
    await expect(findClubPage(db(CLINIC, null), "sapphira")).rejects.toBeInstanceOf(
      ClinicNotFoundError
    );
  });
});
