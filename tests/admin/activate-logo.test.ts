import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { BORROWED_DEFAULT_IMAGE_URLS } from "../../src/modules/templates/own-logo";
import { call, createClinicWithLogo, db, removeClinic } from "./admin-clinics.harness";

const DEFAULT_LOGO = vi.hoisted(() => "https://cdn.voone.example/voone-logo.png");
const MESSAGE = "Añade el logo propio del centro antes de activarlo.";

// The route reads the configured default at request time, so the test sets it for the
// route's config object rather than the process environment (config is parsed once).
vi.mock("../../src/config/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/config/env")>();

  return { ...original, config: { ...original.config, VOONE_DEFAULT_LOGO_URL: DEFAULT_LOGO } };
});

const created: string[] = [];

const clinicWith = async (logoUrl: string | null) => {
  const clinic = await createClinicWithLogo(logoUrl);

  created.push(clinic.id);

  return clinic;
};

afterEach(async () => {
  while (created.length > 0) await removeClinic(created.pop() as string);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("POST /admin/clinics/:clinicId/activate needs the clinic's own logo", () => {
  it.each([
    ["no logo", null],
    ["an empty logo", ""],
    ["a whitespace logo", "   "],
    ["the configured Voone default logo", DEFAULT_LOGO],
    ["the first borrowed image", BORROWED_DEFAULT_IMAGE_URLS[0]],
    ["the second borrowed image", BORROWED_DEFAULT_IMAGE_URLS[1]]
  ])("refuses a clinic with %s and leaves it inactive", async (_label, logoUrl) => {
    const clinic = await clinicWith(logoUrl);

    const reply = await call("POST", `/admin/clinics/${clinic.id}/activate`);

    expect(reply.status).toBe(422);
    expect(reply.body.message).toBe(MESSAGE);
    expect((await db.clinic.findUniqueOrThrow({ where: { id: clinic.id } })).isActive).toBe(false);
  });

  it("activates a clinic whose logo is its own", async () => {
    const clinic = await clinicWith("https://clinica.example/logo.png");

    const reply = await call("POST", `/admin/clinics/${clinic.id}/activate`);

    expect(reply.status).toBe(200);
    expect(reply.body.isActive).toBe(true);
    expect((await db.clinic.findUniqueOrThrow({ where: { id: clinic.id } })).isActive).toBe(true);
  });

  it("does not flag a genuine image that merely shares the borrowed images' host", async () => {
    const clinic = await clinicWith("https://i.ibb.co/own1234/clinic-logo.png");

    const reply = await call("POST", `/admin/clinics/${clinic.id}/activate`);

    expect(reply.status).toBe(200);
  });
});
