import { OnboardingProgramStatus, type PrismaClient } from "@prisma/client";

import { hasActiveProgram } from "./program-tier.port";

/**
 * The unit a client sees. The engine keeps progress in euros (thresholds, tiers and rewards are
 * all euro figures); everything shown to a client or to staff as "points" is that progress
 * times this constant, so one euro spent is ten points. Converted at the edge, never stored,
 * so no threshold or balance has to be rescaled.
 */
export const POINTS_PER_EURO = 10;

export const toPoints = (progress: number): number => Math.round(progress * POINTS_PER_EURO);

/** Whether a clinic has published a programme, which is what makes it keep progress in euros. */
export const isProgrammeCentre = (prisma: PrismaClient, clinicId: string): Promise<boolean> =>
  hasActiveProgram(prisma, clinicId);

/**
 * Which of these clinics are programme centres, from one query. For a list that spans clinics,
 * where asking per member (or per clinic) would be a query per row. Same rule as
 * `isProgrammeCentre`: an ACTIVO programme.
 */
export const programmeCentreIds = async (
  prisma: PrismaClient,
  clinicIds: readonly string[]
): Promise<Set<string>> => {
  if (clinicIds.length === 0) return new Set();

  const rows = await prisma.onboardingProgram.findMany({
    where: { clinicId: { in: [...new Set(clinicIds)] }, status: OnboardingProgramStatus.ACTIVO },
    select: { clinicId: true },
    distinct: ["clinicId"]
  });

  return new Set(rows.map((row) => row.clinicId));
};

/**
 * The balance as a client or staff member should read it: points at a programme centre, the
 * ledger's own figure everywhere else. The one place that decides, so a surface cannot show
 * euros where another shows points.
 */
export const displayPoints = async (
  prisma: PrismaClient,
  clinicId: string,
  progress: number
): Promise<number> => ((await isProgrammeCentre(prisma, clinicId)) ? toPoints(progress) : progress);
