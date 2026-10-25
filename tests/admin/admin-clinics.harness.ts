import { OnboardingProgramStatus, PrismaClient } from "@prisma/client";
import express from "express";

import { errorHandler } from "../../src/common/middleware/error-handler";
import { config } from "../../src/config/env";
import { adminClinicsRouter } from "../../src/routes/v1/admin-clinics.route";

/**
 * The admin clinics router over HTTP against the local test database, with the rows a
 * clinic needs to be activatable. Shared by the activation and clinic-list tests, which
 * differ only in what the clinic's logo is.
 */
export const db = new PrismaClient();

const app = express();

app.use(express.json());
app.use("/api/v1", adminClinicsRouter);
app.use(errorHandler);

export interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const call = async (method: string, path: string): Promise<Reply> => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: config.STAFF_API_KEY ? { "x-voone-staff-key": config.STAFF_API_KEY } : {}
    });
    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
};

let sequence = 0;

/** A draft clinic with a card and a live programme: everything but a logo decision. */
export const createClinicWithLogo = async (
  logoUrl: string | null,
  options: { withTemplate?: boolean } = {}
): Promise<{ id: string; slug: string }> => {
  const slug = `logo-${process.pid}-${Date.now()}-${(sequence += 1)}`;
  const preset = await db.templatePreset.findFirstOrThrow();
  const clinic = await db.clinic.create({
    data: {
      slug,
      name: `Centro ${slug}`,
      addressLine: "Calle Prueba 1",
      pincode: "08001",
      isActive: false
    }
  });

  if (options.withTemplate !== false) {
    await db.clinicTemplate.create({
      data: {
        clinicId: clinic.id,
        presetId: preset.id,
        programName: "Club Prueba",
        hexBackgroundColor: "#30221f",
        logoUrl,
        pointsLabel: "Puntos",
        tierLabel: "Nivel",
        benefitsText: "Ventajas exclusivas para socias.",
        infoText: "Presenta tu pase en recepción."
      }
    });
  }

  await db.onboardingProgram.create({
    data: {
      clinicId: clinic.id,
      version: 1,
      status: OnboardingProgramStatus.ACTIVO,
      engineVersion: "test",
      configVersion: "test",
      answers: {},
      output: {},
      catalogSnapshot: []
    }
  });

  return { id: clinic.id, slug };
};

export const removeClinic = async (clinicId: string): Promise<void> => {
  await db.onboardingProgram.deleteMany({ where: { clinicId } });
  await db.clinicTemplate.deleteMany({ where: { clinicId } });
  await db.clinic.deleteMany({ where: { id: clinicId } });
};
