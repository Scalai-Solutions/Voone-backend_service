import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { BORROWED_DEFAULT_IMAGE_URLS } from "../../src/modules/templates/own-logo";
import { call, createClinicWithLogo, db, removeClinic } from "./admin-clinics.harness";

const DEFAULT_LOGO = vi.hoisted(() => "https://cdn.voone.example/voone-logo.png");

vi.mock("../../src/config/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/config/env")>();

  return { ...original, config: { ...original.config, VOONE_DEFAULT_LOGO_URL: DEFAULT_LOGO } };
});

const created: string[] = [];

/** The flag the admin list reports for a clinic created with this logo (or no template). */
const flagFor = async (
  logoUrl: string | null,
  options: Parameters<typeof createClinicWithLogo>[1] = {}
): Promise<boolean> => {
  const clinic = await createClinicWithLogo(logoUrl, options);

  created.push(clinic.id);

  const reply = await call("GET", `/admin/clinics?q=${encodeURIComponent(clinic.slug)}`);

  expect(reply.status).toBe(200);

  const summary = reply.body.find((item: { id: string }) => item.id === clinic.id);

  expect(summary).toBeDefined();

  return summary.usesDefaultLogo;
};

afterEach(async () => {
  while (created.length > 0) await removeClinic(created.pop() as string);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("GET /admin/clinics flags clinics on a default logo", () => {
  it.each([
    ["no logo", null],
    ["an empty logo", ""],
    ["a whitespace logo", "  "],
    ["the configured Voone default logo", DEFAULT_LOGO],
    ["the first borrowed image", BORROWED_DEFAULT_IMAGE_URLS[0]],
    ["the second borrowed image", BORROWED_DEFAULT_IMAGE_URLS[1]]
  ])("usesDefaultLogo is true for %s", async (_label, logoUrl) => {
    expect(await flagFor(logoUrl)).toBe(true);
  });

  it("is false for a logo of the clinic's own", async () => {
    expect(await flagFor("https://clinica.example/logo.png")).toBe(false);
  });

  it("is false for a genuine image on the borrowed images' host", async () => {
    expect(await flagFor("https://i.ibb.co/own1234/clinic-logo.png")).toBe(false);
  });

  it("is true for a clinic that has no template at all", async () => {
    expect(await flagFor(null, { withTemplate: false })).toBe(true);
  });

  it("is true when the logo is its own but the hero image is a borrowed one", async () => {
    expect(
      await flagFor("https://clinica.example/logo.png", {
        heroImageUrl: BORROWED_DEFAULT_IMAGE_URLS[1]
      })
    ).toBe(true);
  });

  it("is true when the logo is its own but the dark logo is a borrowed one", async () => {
    expect(
      await flagFor("https://clinica.example/logo.png", {
        logoOnDarkUrl: BORROWED_DEFAULT_IMAGE_URLS[0]
      })
    ).toBe(true);
  });

  it("is false when the logo and the hero image are both its own", async () => {
    expect(
      await flagFor("https://clinica.example/logo.png", {
        heroImageUrl: "https://clinica.example/hero.png"
      })
    ).toBe(false);
  });
});
