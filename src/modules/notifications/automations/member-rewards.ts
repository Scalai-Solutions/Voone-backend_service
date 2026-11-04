import { OnboardingProgramStatus, type PrismaClient } from "@prisma/client";

import type { Program } from "../../onboarding/engine.types";
import { itemsTitle } from "../../onboarding/reward-title";
import { programView, type ProgramView } from "../../onboarding/runtime/program-view";
import { referralRewardAt, tierKeyOf } from "../../onboarding/runtime/rules";

/**
 * What a message promises a member comes from the clinic's live programme, never from text
 * someone typed: the programme is what actually issues the reward, so the message cannot drift
 * from it.
 */

/** Used when the programme names nothing for this member (a tier without a birthday gift). */
export const GENERIC_BIRTHDAY_GIFT = "un detalle especial de nuestra parte";

/** Used when no referral reward can be worked out; the programme always has one in practice. */
export const GENERIC_REFERRAL_REWARD = "una ventaja especial";

/** Rewards are at most a few referrals apart, so this finds the next one with room to spare. */
const MAX_REFERRALS_AHEAD = 100;

/** The clinic's published programme, as the engine produced it, or null when it has none. */
export const loadActiveProgram = async (
  prisma: PrismaClient,
  clinicId: string
): Promise<Program | null> => {
  const row = await prisma.onboardingProgram.findFirst({
    where: { clinicId, status: OnboardingProgramStatus.ACTIVO },
    select: { output: true }
  });

  return row ? (row.output as unknown as Program) : null;
};

/**
 * The reward the member's next rewarded referral will earn them, given how many of their
 * referrals have already counted. Uses the same rule that issues the reward (`referralRewardAt`),
 * so what the message says is what they receive.
 */
export const nextReferralReward = (program: Program, countedReferrals: number): string => {
  const view: ProgramView = programView(program);

  for (let rank = countedReferrals + 1; rank <= countedReferrals + MAX_REFERRALS_AHEAD; rank += 1) {
    const reward = referralRewardAt(view, rank);

    if (reward) return reward.title;
  }

  return GENERIC_REFERRAL_REWARD;
};

/** The birthday gift the programme assigns to the member's tier; a member with no tier is Bronce. */
export const birthdayGiftFor = (program: Program | null, tier: string | null): string => {
  const gift = program?.gifts[tierKeyOf(tier) ?? "bronce"]?.birthday;

  return gift ? itemsTitle(gift.items) : GENERIC_BIRTHDAY_GIFT;
};
