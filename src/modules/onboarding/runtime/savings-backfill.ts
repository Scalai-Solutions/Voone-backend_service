import { MemberRewardKind, MemberSavingKind, type PrismaClient } from "@prisma/client";

import { giftSaving, syncSavingsCache } from "./savings";

/**
 * Counts the gifts members have ALREADY redeemed towards their savings total (see
 * scripts/backfill-savings.ts for why, and for how to run it).
 *
 * Gifts only: nothing else was recorded with an amount, and a discount or a perk is never
 * reconstructed by guessing. Idempotent: a row is keyed by its reward, and each member's cached total
 * is SET from their rows rather than incremented.
 */

const BATCH = 200;

export interface SavingsBackfillResult {
  /** Redeemed gifts that carry a stored value. */
  counted: number;
  members: number;
  cents: number;
  /** Redeemed with no stored value, so not counted. */
  skipped: number;
  /** Members whose cached total was set; 0 on a dry run. */
  written: number;
}

export const backfillSavings = async (
  prisma: PrismaClient,
  options: { clinicId?: string; apply: boolean }
): Promise<SavingsBackfillResult> => {
  const members = new Set<string>();
  const result: SavingsBackfillResult = {
    counted: 0,
    members: 0,
    cents: 0,
    skipped: 0,
    written: 0
  };
  let cursor: string | undefined;

  for (;;) {
    const rewards = await prisma.memberReward.findMany({
      where: {
        redeemedAt: { not: null },
        // A perk is valued by the centre going forward; a past one is never back-valued.
        kind: { not: MemberRewardKind.VENTAJA },
        ...(options.clinicId ? { clinicId: options.clinicId } : {})
      },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
    });

    if (!rewards.length) break;

    cursor = rewards[rewards.length - 1].id;

    for (const reward of rewards) {
      const saving = giftSaving(reward.kind, reward.detail, {});

      if (!saving) {
        result.skipped += 1;
        continue;
      }

      result.counted += 1;
      result.cents += saving.cents;
      members.add(reward.memberId);

      if (!options.apply) continue;

      await prisma.memberSaving.createMany({
        data: [
          {
            clinicId: reward.clinicId,
            memberId: reward.memberId,
            kind: MemberSavingKind.GIFT,
            cents: saving.cents,
            sourceKey: `reward:${reward.id}`,
            createdAt: reward.redeemedAt ?? undefined
          }
        ],
        skipDuplicates: true
      });
    }
  }

  result.members = members.size;

  if (!options.apply) return result;

  const withRows = await prisma.memberSaving.findMany({
    where: options.clinicId ? { clinicId: options.clinicId } : {},
    distinct: ["memberId"],
    select: { memberId: true }
  });

  for (const { memberId } of withRows) {
    await prisma.$transaction((tx) => syncSavingsCache(tx, memberId));
  }

  result.written = withRows.length;

  return result;
};
