import { OnboardingProgramStatus, type PrismaClient } from "@prisma/client";

import type { ProgramTierPort } from "../../points/points.service";
import type { Program } from "../engine.types";
import { programView, type ProgramView } from "./program-view";
import { milestonesCrossed, recurringCrossed, resolveTier, tenureMonths, tierKeyOf } from "./rules";

/**
 * Decides tiers for clinics that have published an onboarding programme.
 *
 * Returns null for a clinic that has not, and PointsService then applies the legacy rules
 * unchanged — so adopting the new programme is something a clinic does by publishing, never
 * something that happens to it, and nobody's tier moves until they do.
 */

/** Loads the clinic's live programme as the runtime reads it, or null. */
export const activeProgramView = async (
  prisma: PrismaClient,
  clinicId: string
): Promise<{ id: string; view: ProgramView } | null> => {
  const row = await prisma.onboardingProgram.findFirst({
    where: { clinicId, status: OnboardingProgramStatus.ACTIVO },
    select: { id: true, output: true }
  });

  return row ? { id: row.id, view: programView(row.output as unknown as Program) } : null;
};

export class PrismaProgramTierPort implements ProgramTierPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date()
  ) {}

  async resolve(input: Parameters<ProgramTierPort["resolve"]>[0]) {
    const active = await activeProgramView(this.prisma, input.clinicId);

    if (!active) return null;

    const member = await this.prisma.member.findUnique({
      where: { id: input.memberId },
      select: { createdAt: true }
    });

    // A member that has vanished cannot be ranked. Null falls back to the legacy path, which
    // will fail more legibly than a thrown error from here would.
    if (!member) return null;

    const resolution = resolveTier(active.view, {
      progress: input.lifetime,
      // Tenure runs from sign-up — see RUNTIME_DECISIONS.tenureStartsAt.
      tenureMonths: tenureMonths(member.createdAt, this.now()),
      current: tierKeyOf(input.current),
      allowDemotion: input.allowDemotion
    });

    const { tier } = resolution;

    return {
      // The name is the code, as in the legacy scale: it is what the pass shows, and there is
      // no second identifier for anyone to keep in step.
      tier: { code: tier.label, label: tier.label, minLifetimePoints: tier.floor },
      milestoneCrossed: (before: number, after: number) =>
        milestonesCrossed(active.view, before, after).length > 0 ||
        recurringCrossed(active.view, before, after).length > 0
    };
  }
}
