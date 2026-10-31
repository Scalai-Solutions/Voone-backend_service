import { OnboardingProgramStatus, type PrismaClient } from "@prisma/client";

import type { Program } from "../../onboarding/engine.types";
import { presentProgram } from "../../onboarding/presentation";
import { tierKeyOf } from "../../onboarding/runtime/rules";
import { tierRewardsSchema } from "../../templates/templates.schema";
import type { AutomationDispatchService } from "./dispatch.service";

const MAX_SUMMARY_LENGTH = 160;
const FALLBACK_SUMMARY = "nuevas ventajas pensadas para ti";

/** Cuts at a word boundary so the summary never ends mid-word in a push. */
const clip = (text: string): string => {
  if (text.length <= MAX_SUMMARY_LENGTH) return text;

  const cut = text.slice(0, MAX_SUMMARY_LENGTH - 1);

  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : undefined)}…`;
};

/**
 * Where a tier's perks come from: the published programme's presented benefits, or for a clinic
 * on the legacy scale the reward text it typed for the tier.
 */
export const tierBenefitsSummary = async (
  prisma: PrismaClient,
  clinicId: string,
  tierName: string
): Promise<string> => {
  const program = await prisma.onboardingProgram.findFirst({
    where: { clinicId, status: OnboardingProgramStatus.ACTIVO },
    select: { output: true }
  });

  if (program) {
    const key = tierKeyOf(tierName);
    const tier = presentProgram(program.output as unknown as Program).tiers.find(
      (candidate) => candidate.key === key
    );

    return clip(tier?.benefits.slice(0, 3).join("; ") || FALLBACK_SUMMARY);
  }

  const template = await prisma.clinicTemplate.findUnique({
    where: { clinicId },
    select: { tierRewards: true }
  });
  const parsed = tierRewardsSchema.safeParse(template?.tierRewards ?? []);
  const rewardText = parsed.success
    ? parsed.data.find((tier) => tier.name === tierName)?.rewardText
    : undefined;

  return clip(rewardText?.trim() || FALLBACK_SUMMARY);
};

/** EVT-008: congratulates a member the moment they cross into a higher tier. */
export class TierUpgradeNotifier {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sender: AutomationDispatchService
  ) {}

  async notify(input: { memberId: string; clinicId: string; newTier: string }) {
    return this.sender.dispatch({
      clinicId: input.clinicId,
      event: "TIER_UPGRADE",
      // One congratulation per member per tier, however many times the job retries.
      idempotencyKey: `tier:${input.memberId}:${input.newTier}`,
      recipients: [
        {
          memberId: input.memberId,
          values: {
            new_tier: input.newTier,
            benefits_summary: await tierBenefitsSummary(this.prisma, input.clinicId, input.newTier)
          }
        }
      ],
      meta: { tier: input.newTier }
    });
  }
}
