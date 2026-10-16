import { PointsTransactionKind, type PrismaClient } from "@prisma/client";

import { activeProgramView } from "./program-tier.port";
import { resolveTier, tenureMonths, tierKeyOf } from "./rules";

/**
 * Puts every member of a clinic on the live programme's ladder, by the progress she already has.
 *
 * Run when a new version replaces a live one. Progress is stored in euros, not in milestones, so
 * it carries across untouched; what changes is where the tiers sit on it. A member whose progress
 * now meets a higher tier is moved up. Nobody is moved down: the guide says tiers are not lost,
 * and a centre that revises its programme must not demote the clients it already rewarded
 * (the one exception, an explicit staff correction, is handled where corrections are).
 *
 * Idempotent and safe to run again: it only ever raises a tier, so a retry after a failure
 * finishes the job. It is deliberately not part of the publishing transaction, so a clinic with
 * thousands of members does not hold a lock on all of them.
 */

const LIFETIME_KINDS = [
  PointsTransactionKind.EARN,
  PointsTransactionKind.REFERRAL,
  PointsTransactionKind.ADJUSTMENT
];

export interface PlacementOutcome {
  checked: number;
  promoted: number;
}

export const placeMembersOnProgram = async (
  prisma: PrismaClient,
  clinicId: string,
  now: Date = new Date()
): Promise<PlacementOutcome> => {
  const active = await activeProgramView(prisma, clinicId);

  if (!active) return { checked: 0, promoted: 0 };

  const [members, sums] = await Promise.all([
    prisma.member.findMany({
      where: { clinicId, erasedAt: null },
      select: { id: true, tier: true, createdAt: true }
    }),
    prisma.pointsTransaction.groupBy({
      by: ["memberId"],
      where: { member: { clinicId }, kind: { in: LIFETIME_KINDS } },
      _sum: { points: true }
    })
  ]);

  const lifetime = new Map(sums.map((s) => [s.memberId, s._sum.points ?? 0]));
  let promoted = 0;

  for (const member of members) {
    const { tier } = resolveTier(active.view, {
      progress: lifetime.get(member.id) ?? 0,
      tenureMonths: tenureMonths(member.createdAt, now),
      current: tierKeyOf(member.tier),
      allowDemotion: false
    });

    if (tier.label === member.tier) continue;

    await prisma.member.update({ where: { id: member.id }, data: { tier: tier.label } });
    promoted += 1;
  }

  return { checked: members.length, promoted };
};
