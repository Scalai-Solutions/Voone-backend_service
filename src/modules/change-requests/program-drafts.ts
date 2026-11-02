import type { OnboardingProgramStatus, PrismaClient } from "@prisma/client";

import type { OnboardingService } from "../onboarding/onboarding.service";

/**
 * What a ticket needs from the clinic's programmes: find the live one or the draft, clone the
 * live one into a draft, and read a programme's status. The cloning is OnboardingService's own
 * `cloneDraft`, so a draft made from a ticket is exactly what the programme screen makes.
 */
export interface ProgramDrafts {
  activeProgramId(clinicId: string): Promise<string | null>;
  draftProgramId(clinicId: string): Promise<string | null>;
  /** Clones the programme into a new draft and returns the draft's id. */
  cloneDraft(clinicId: string, programId: string): Promise<string>;
  /** The programme's status, or null when it is not this clinic's. */
  statusOf(clinicId: string, programId: string): Promise<OnboardingProgramStatus | null>;
}

export class PrismaProgramDrafts implements ProgramDrafts {
  constructor(
    private readonly db: PrismaClient,
    private readonly onboarding: Pick<OnboardingService, "cloneDraft">
  ) {}

  private async idWithStatus(clinicId: string, status: OnboardingProgramStatus) {
    const row = await this.db.onboardingProgram.findFirst({
      where: { clinicId, status },
      orderBy: { version: "desc" },
      select: { id: true }
    });

    return row?.id ?? null;
  }

  activeProgramId(clinicId: string): Promise<string | null> {
    return this.idWithStatus(clinicId, "ACTIVO");
  }

  draftProgramId(clinicId: string): Promise<string | null> {
    return this.idWithStatus(clinicId, "BORRADOR");
  }

  async cloneDraft(clinicId: string, programId: string): Promise<string> {
    return (await this.onboarding.cloneDraft(clinicId, programId)).id;
  }

  async statusOf(clinicId: string, programId: string): Promise<OnboardingProgramStatus | null> {
    const row = await this.db.onboardingProgram.findFirst({
      where: { id: programId, clinicId },
      select: { status: true }
    });

    return row?.status ?? null;
  }
}
