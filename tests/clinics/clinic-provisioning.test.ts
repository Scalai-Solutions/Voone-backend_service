import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  ClinicSlugTakenError,
  TemplatePresetNotFoundError
} from "../../src/common/errors/membership.errors";
import { provisionClinicSchema } from "../../src/modules/clinics/clinic-provisioning.schema";
import {
  provisionClinic,
  toProvisionedSummary
} from "../../src/modules/clinics/clinic-provisioning.service";

const PRESET = { id: "p1", name: "Classic Gold", hexBackgroundColor: "#ead0bd" };

const VALID = {
  slug: "clinica-nova",
  name: "Clínica Nova",
  addressLine: "Carrer de Balmes 12",
  pincode: "08007",
  presetId: "p1",
  programName: "Nova Beauty Club"
};

const db = (over: Record<string, unknown> = {}) => {
  const clinicCreate = vi.fn().mockResolvedValue({ id: "c1", slug: VALID.slug });
  const templateCreate = vi.fn().mockResolvedValue({ id: "t1", programName: VALID.programName });

  return {
    handle: {
      templatePreset: { findUnique: vi.fn().mockResolvedValue(PRESET) },
      // Runs the callback inline: the transaction is here for atomicity, not control flow.
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ clinic: { create: clinicCreate }, clinicTemplate: { create: templateCreate } })
      ),
      ...over
    },
    clinicCreate,
    templateCreate
  };
};

describe("provisionClinicSchema", () => {
  it("fills the copy an operator does not have to hand", () => {
    const parsed = provisionClinicSchema.parse(VALID);

    expect(parsed.pointsLabel).toBe("Puntos");
    expect(parsed.tierLabel).toBe("Nivel");
    expect(parsed.benefitsText.length).toBeGreaterThan(8);
    expect(parsed.infoText.length).toBeGreaterThan(8);
  });

  it("refuses a colour, because that is the preset's job", () => {
    const parsed = provisionClinicSchema.parse({ ...VALID, hexBackgroundColor: "#ff0000" });

    expect(parsed).not.toHaveProperty("hexBackgroundColor");
  });

  it("applies the same slug rules as the public URL", () => {
    for (const slug of ["Clinica-Nova", "clinica nova", "clinica/nova", "-nova", ""]) {
      expect(provisionClinicSchema.safeParse({ ...VALID, slug }).success, slug).toBe(false);
    }
  });

  it("rejects a clinic name longer than the pass can carry", () => {
    expect(provisionClinicSchema.safeParse({ ...VALID, name: "á".repeat(49) }).success).toBe(false);
  });
});

describe("provisionClinic", () => {
  it("creates the clinic and its template in one transaction", async () => {
    const { handle, clinicCreate, templateCreate } = db();

    await provisionClinic(handle as never, provisionClinicSchema.parse(VALID));

    expect(handle.$transaction).toHaveBeenCalledOnce();
    expect(clinicCreate).toHaveBeenCalledOnce();
    expect(templateCreate).toHaveBeenCalledOnce();
  });

  it("takes the colour from the preset, not the request", async () => {
    const { handle, templateCreate } = db();

    await provisionClinic(handle as never, provisionClinicSchema.parse(VALID));

    expect(templateCreate.mock.calls[0][0].data.hexBackgroundColor).toBe("#ead0bd");
  });

  it("refuses an unknown preset before writing anything", async () => {
    const { handle } = db({ templatePreset: { findUnique: vi.fn().mockResolvedValue(null) } });

    await expect(
      provisionClinic(handle as never, provisionClinicSchema.parse(VALID))
    ).rejects.toThrow(TemplatePresetNotFoundError);
    expect(handle.$transaction).not.toHaveBeenCalled();
  });

  it("reports a taken slug as a conflict, not a 500", async () => {
    // Two operators can submit the same slug at once, so the unique index is what settles
    // it rather than a prior existence check.
    const { handle } = db({
      $transaction: vi.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: Prisma.prismaVersion.client,
          meta: { target: ["slug"] }
        })
      )
    });

    const attempt = provisionClinic(handle as never, provisionClinicSchema.parse(VALID));

    await expect(attempt).rejects.toThrow(ClinicSlugTakenError);
    await expect(attempt).rejects.toMatchObject({ statusCode: 409, expose: true });
  });

  it("does not disguise an unrelated database failure as a slug conflict", async () => {
    const outage = new Prisma.PrismaClientKnownRequestError("Cannot reach database", {
      code: "P1001",
      clientVersion: Prisma.prismaVersion.client
    });
    const { handle } = db({ $transaction: vi.fn().mockRejectedValue(outage) });

    await expect(provisionClinic(handle as never, provisionClinicSchema.parse(VALID))).rejects.toBe(
      outage
    );
  });
});

describe("toProvisionedSummary", () => {
  it("returns the slug the operator has to print, and nothing internal", () => {
    const summary = toProvisionedSummary({
      clinic: {
        id: "c1",
        slug: "clinica-nova",
        name: "Clínica Nova",
        addressLine: "Carrer de Balmes 12",
        pincode: "08007",
        isActive: true,
        privacyPolicyVersion: "v1",
        createdAt: new Date(),
        updatedAt: new Date()
      },
      template: {
        id: "t1",
        clinicId: "c1",
        presetId: "p1",
        programName: "Nova Beauty Club",
        hexBackgroundColor: "#ead0bd",
        logoUrl: null,
        heroImageUrl: null,
        pointsLabel: "Puntos",
        tierLabel: "Nivel",
        benefitsText: "x".repeat(10),
        infoText: "x".repeat(10),
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date()
      }
    });

    expect(summary.clinic.slug).toBe("clinica-nova");
    expect(summary.clinic).not.toHaveProperty("addressLine");
    expect(summary.clinic).not.toHaveProperty("pincode");
    expect(summary.template.status).toBe("PENDING");
  });
});
