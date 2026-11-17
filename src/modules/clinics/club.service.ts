import { OnboardingProgramStatus, type PrismaClient } from "@prisma/client";

import { ClinicNotFoundError } from "../../common/errors/membership.errors";
import type { Program } from "../onboarding/engine.types";
import { clubView, type PublicClub } from "../onboarding/club-view";
import { findClinicBySlug, toPublicClinic, type PublicClinic } from "./clinic.service";

export interface PublicClubPage {
  clinic: PublicClinic;
  club: PublicClub;
}

/**
 * The public club page of a clinic: its branding and what its live programme gives a client.
 *
 * Every way of having nothing to show (unknown or inactive clinic, no template, no live programme)
 * is the same ClinicNotFoundError, so this page cannot be used to probe which clinics exist or
 * which are still being set up.
 */
export const findClubPage = async (db: PrismaClient, key: string): Promise<PublicClubPage> => {
  const clinic = await findClinicBySlug(db, key);

  if (!clinic.template) throw new ClinicNotFoundError(key);

  const live = await db.onboardingProgram.findFirst({
    where: { clinicId: clinic.id, status: OnboardingProgramStatus.ACTIVO },
    select: { output: true }
  });

  if (!live) throw new ClinicNotFoundError(key);

  return {
    clinic: toPublicClinic(clinic, clinic.template),
    club: clubView(live.output as unknown as Program)
  };
};
