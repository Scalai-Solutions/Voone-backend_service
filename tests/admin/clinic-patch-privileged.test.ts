import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ADMIN_ACTOR, call, createClinicWithLogo, db, removeClinic } from "./admin-clinics.harness";

const OWN_LOGO = "https://clinica.example/logo.png";
const created: string[] = [];

/** A live clinic on the starter plan: plan and active flag are what the tests try to move. */
const liveClinic = async () => {
  const clinic = await createClinicWithLogo(OWN_LOGO, { isActive: true });

  created.push(clinic.id);

  return clinic;
};

const row = (id: string) => db.clinic.findUniqueOrThrow({ where: { id } });
const patch = (id: string, body: unknown, headers?: Record<string, string>) =>
  call("PATCH", `/admin/clinics/${id}`, body, headers);

afterEach(async () => {
  while (created.length > 0) await removeClinic(created.pop() as string);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("PATCH /admin/clinics/:clinicId privileged fields", () => {
  it("ignores voonePlan and isActive without the admin header, and says so", async () => {
    const clinic = await liveClinic();
    const before = await row(clinic.id);

    const reply = await patch(clinic.id, { voonePlan: "pro", isActive: false });

    expect(reply.status).toBe(200);
    expect(reply.body.ignoredFields).toEqual(["voonePlan", "isActive"]);

    const after = await row(clinic.id);

    expect(after.voonePlan).toBe(before.voonePlan);
    expect(after.notificationsMonthlyQuota).toBe(before.notificationsMonthlyQuota);
    expect(after.isActive).toBe(true);
  });

  it("still saves centre and billing details without the header, alongside ignored fields", async () => {
    const clinic = await liveClinic();

    const reply = await patch(clinic.id, {
      name: "Centro Renombrado",
      addressLine: "Calle Nueva 2",
      pincode: "28001",
      billingName: "Razón Social SL",
      billingTaxId: "B12345678",
      billingEmail: "facturas@clinica.example",
      billingAddressLine: "Calle Factura 3",
      billingPostalCode: "28002",
      voonePlan: "pro"
    });

    expect(reply.status).toBe(200);
    expect(reply.body.ignoredFields).toEqual(["voonePlan"]);
    expect(await row(clinic.id)).toMatchObject({
      name: "Centro Renombrado",
      addressLine: "Calle Nueva 2",
      pincode: "28001",
      billingName: "Razón Social SL",
      billingTaxId: "B12345678",
      billingEmail: "facturas@clinica.example",
      billingAddressLine: "Calle Factura 3",
      billingPostalCode: "28002",
      voonePlan: "starter",
      isActive: true
    });
  });

  it("reports nothing ignored when only allowed fields are sent", async () => {
    const clinic = await liveClinic();

    const reply = await patch(clinic.id, { name: "Otro Nombre" });

    expect(reply.status).toBe(200);
    expect(reply.body.ignoredFields).toBeUndefined();
    expect((await row(clinic.id)).name).toBe("Otro Nombre");
  });

  it("does not let an owner switch a draft on without the header", async () => {
    const draft = await createClinicWithLogo(OWN_LOGO, { isActive: false });

    created.push(draft.id);

    const reply = await patch(draft.id, { isActive: true });

    expect(reply.status).toBe(200);
    expect(reply.body.ignoredFields).toEqual(["isActive"]);
    expect((await row(draft.id)).isActive).toBe(false);
  });

  it("applies voonePlan (and its quota) and isActive with the admin header", async () => {
    const clinic = await liveClinic();

    const reply = await patch(clinic.id, { voonePlan: "pro", isActive: false }, ADMIN_ACTOR);

    expect(reply.status).toBe(200);
    expect(reply.body.ignoredFields).toBeUndefined();

    const after = await row(clinic.id);

    expect(after.voonePlan).toBe("pro");
    expect(after.notificationsMonthlyQuota).toBe(30);
    expect(after.isActive).toBe(false);
  });

  it("does not treat any other role value as the admin signal", async () => {
    const clinic = await liveClinic();

    for (const role of ["owner", "VOONE_ADMIN", "voone_admin,owner", ""]) {
      const reply = await patch(clinic.id, { voonePlan: "pro" }, { "x-actor-role": role });

      expect(reply.body.ignoredFields).toEqual(["voonePlan"]);
    }

    expect((await row(clinic.id)).voonePlan).toBe("starter");
  });

  it("reports a privileged key as ignored even when it equals the current value", async () => {
    const clinic = await liveClinic();

    const reply = await patch(clinic.id, { isActive: true });

    // The clinic is already active, but the caller may not set the flag at all.
    expect(reply.body.ignoredFields).toEqual(["isActive"]);
  });
});
