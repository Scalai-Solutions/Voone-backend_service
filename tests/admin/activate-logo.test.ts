import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { BORROWED_DEFAULT_IMAGE_URLS } from "../../src/modules/templates/own-logo";
import { call, createClinicWithLogo, db, removeClinic } from "./admin-clinics.harness";

const DEFAULT_LOGO = vi.hoisted(() => "https://cdn.voone.example/voone-logo.png");
const MESSAGE = "Añade el logo propio del centro antes de activarlo.";
const IMAGE_MESSAGE =
  "Quita la imagen de ejemplo de la tarjeta o sustitúyela por la del centro antes de activarlo.";
const OWN = "https://clinica.example/logo.png";

// The route reads the configured default at request time, so the test sets it for the
// route's config object rather than the process environment (config is parsed once).
vi.mock("../../src/config/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/config/env")>();

  return { ...original, config: { ...original.config, VOONE_DEFAULT_LOGO_URL: DEFAULT_LOGO } };
});

const created: string[] = [];

const clinicWith = async (
  logoUrl: string | null,
  options: Parameters<typeof createClinicWithLogo>[1] = {}
) => {
  const clinic = await createClinicWithLogo(logoUrl, options);

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

describe("activation also refuses borrowed hero and dark-logo images", () => {
  const isActive = async (id: string) =>
    (await db.clinic.findUniqueOrThrow({ where: { id } })).isActive;

  it("refuses an own logo with the borrowed hero image, and leaves it inactive", async () => {
    const clinic = await clinicWith(OWN, { heroImageUrl: BORROWED_DEFAULT_IMAGE_URLS[1] });

    const reply = await call("POST", `/admin/clinics/${clinic.id}/activate`);

    expect(reply.status).toBe(422);
    expect(reply.body.message).toBe(IMAGE_MESSAGE);
    expect(await isActive(clinic.id)).toBe(false);
  });

  it("refuses an own logo with a borrowed dark logo", async () => {
    const clinic = await clinicWith(OWN, { logoOnDarkUrl: BORROWED_DEFAULT_IMAGE_URLS[0] });

    const reply = await call("POST", `/admin/clinics/${clinic.id}/activate`);

    expect(reply.status).toBe(422);
    expect(reply.body.message).toBe(IMAGE_MESSAGE);
  });

  it("still asks for the logo first when the logo itself is not the clinic's", async () => {
    const clinic = await clinicWith(null, { heroImageUrl: BORROWED_DEFAULT_IMAGE_URLS[1] });

    const reply = await call("POST", `/admin/clinics/${clinic.id}/activate`);

    expect(reply.body.message).toBe(MESSAGE);
  });

  it("activates an own logo with an own hero image", async () => {
    const clinic = await clinicWith(OWN, { heroImageUrl: "https://clinica.example/hero.png" });

    const reply = await call("POST", `/admin/clinics/${clinic.id}/activate`);

    expect(reply.status).toBe(200);
    expect(await isActive(clinic.id)).toBe(true);
  });

  it("re-activating a clinic that is already live is a no-op, whatever its images", async () => {
    const clinic = await clinicWith(null, {
      isActive: true,
      heroImageUrl: BORROWED_DEFAULT_IMAGE_URLS[1]
    });

    const reply = await call("POST", `/admin/clinics/${clinic.id}/activate`);

    expect(reply.status).toBe(200);
    expect(reply.body.isActive).toBe(true);
  });
});

describe("PATCH /admin/clinics/:clinicId with isActive:true goes through the same gate", () => {
  const patch = (id: string, body: unknown) => call("PATCH", `/admin/clinics/${id}`, body);
  const isActive = async (id: string) =>
    (await db.clinic.findUniqueOrThrow({ where: { id } })).isActive;

  it.each([
    ["no logo", null, {}, MESSAGE],
    ["the Voone default logo", DEFAULT_LOGO, {}, MESSAGE],
    ["a borrowed hero image", OWN, { heroImageUrl: BORROWED_DEFAULT_IMAGE_URLS[1] }, IMAGE_MESSAGE]
  ])("refuses a clinic with %s", async (_label, logoUrl, options, message) => {
    const clinic = await clinicWith(logoUrl, options);

    const reply = await patch(clinic.id, { isActive: true });

    expect(reply.status).toBe(422);
    expect(reply.body.message).toBe(message);
    expect(await isActive(clinic.id)).toBe(false);
  });

  it("refuses a clinic with no card", async () => {
    const clinic = await clinicWith(null, { withTemplate: false });

    const reply = await patch(clinic.id, { isActive: true });

    expect(reply.status).toBe(422);
    expect(reply.body.message).toBe("Falta la tarjeta para activar el centro.");
    expect(await isActive(clinic.id)).toBe(false);
  });

  it("activates a clinic that passes every check", async () => {
    const clinic = await clinicWith(OWN);

    const reply = await patch(clinic.id, { isActive: true });

    expect(reply.status).toBe(200);
    expect(await isActive(clinic.id)).toBe(true);
  });

  it("leaves deactivation unrestricted, even for a clinic on a default logo", async () => {
    const clinic = await clinicWith(null, { isActive: true });

    const reply = await patch(clinic.id, { isActive: false });

    expect(reply.status).toBe(200);
    expect(await isActive(clinic.id)).toBe(false);
  });

  it("does not gate a change that is not an activation", async () => {
    const clinic = await clinicWith(null);

    const reply = await patch(clinic.id, { voonePlan: "starter" });

    expect(reply.status).toBe(200);
  });
});
