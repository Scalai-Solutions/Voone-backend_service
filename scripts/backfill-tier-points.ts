/**
 * Gives legacy templates a tier ladder they can actually rank members with.
 *
 * Before the tier model changed, ClinicTemplate.tierRewards held only names. Those
 * templates now parse to five tiers all starting at zero, which the duplicate-floor
 * check rejects — so those clinics show no tier at all, and the milestone progress on
 * every card is blank.
 *
 * This assigns the same default ladder a NEW clinic gets, positionally, keeping whatever
 * names and reward text the clinic already wrote.
 *
 * IT INVENTS NUMBERS, and that is only acceptable because these are defaults rather than
 * decisions: they are exactly what the onboarding form would have offered. A clinic going
 * live must still choose its own in the wizard — VOO-4 is that conversation — and doing
 * so overwrites everything this wrote.
 *
 *   npm run tiers:backfill              # report only
 *   npm run tiers:backfill -- --apply   # write
 */

import { PrismaClient } from "@prisma/client";

import { tierRewardsSchema } from "../src/modules/templates/templates.schema";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const apply = args.includes("--apply");

/**
 * Also give a ladder to templates that have NO tiers at all.
 *
 * Off by default and deliberately separate from the repair above. An empty list parses
 * cleanly, so it is indistinguishable from a clinic that decided it does not want tiers
 * — and silently inventing five for them would be the script overruling a choice rather
 * than fixing a migration. Opt in per run, knowing which clinics it touches.
 */
const includeEmpty = args.includes("--include-empty");

/** Mirrors the schema's defaults: reachable early, steep later. */
const LADDER = [
  { minLifetimePoints: 0, milestoneCount: 5, pointsToNextMilestone: 200 },
  { minLifetimePoints: 1_000, milestoneCount: 5, pointsToNextMilestone: 400 },
  { minLifetimePoints: 3_000, milestoneCount: 5, pointsToNextMilestone: 800 },
  { minLifetimePoints: 7_000, milestoneCount: 5, pointsToNextMilestone: 1_600 },
  { minLifetimePoints: 15_000, milestoneCount: 5, pointsToNextMilestone: 3_000 }
];

/** Beyond the fifth tier, keep doubling rather than stopping or repeating a floor. */
const rungFor = (index: number) => {
  if (index < LADDER.length) return LADDER[index];

  const last = LADDER[LADDER.length - 1];
  const beyond = index - LADDER.length + 1;

  return {
    minLifetimePoints: last.minLifetimePoints * 2 ** beyond,
    milestoneCount: last.milestoneCount,
    pointsToNextMilestone: last.pointsToNextMilestone * 2 ** beyond
  };
};

const main = async (): Promise<void> => {
  const templates = await prisma.clinicTemplate.findMany({
    select: { id: true, clinicId: true, programName: true, tierRewards: true }
  });

  let fixed = 0;
  let healthy = 0;

  for (const template of templates) {
    const current = Array.isArray(template.tierRewards) ? template.tierRewards : [];
    const isEmpty = current.length === 0;

    // Already valid means already authored, or already backfilled. Left alone — this
    // must never overwrite numbers a clinic chose. An empty list is valid too, and is
    // only touched when asked for explicitly.
    if (tierRewardsSchema.safeParse(template.tierRewards).success && !(isEmpty && includeEmpty)) {
      healthy += 1;
      continue;
    }

    const existing = isEmpty
      ? LADDER.map((_, index) => ({
          name: ["Bronze", "Silver", "Gold", "Platinum", "Diamond"][index]
        }))
      : current;

    const repaired = existing.map((tier, index) => {
      const row = (tier ?? {}) as { name?: unknown; rewardText?: unknown };

      return {
        name:
          typeof row.name === "string" && row.name.trim() ? row.name.trim() : `Nivel ${index + 1}`,
        rewardText: typeof row.rewardText === "string" ? row.rewardText : "",
        ...rungFor(index)
      };
    });

    const check = tierRewardsSchema.safeParse(repaired);

    if (!check.success) {
      // Duplicate names, most likely. Reported rather than guessed at: renaming a
      // clinic's tiers is not this script's business.
      console.log(
        `  ${template.clinicId}  ${template.programName}: still invalid after repair — ` +
          check.error.issues.map((i) => i.message).join("; ")
      );
      continue;
    }

    console.log(
      `  ${template.clinicId}  ${template.programName}: ` +
        repaired.map((t) => `${t.name}@${t.minLifetimePoints}`).join(", ")
    );
    fixed += 1;

    if (apply) {
      await prisma.clinicTemplate.update({
        where: { id: template.id },
        data: { tierRewards: repaired }
      });
    }
  }

  console.log(
    `\n  ${templates.length} template(s) checked, ${healthy} already valid, ` +
      (apply ? `${fixed} repaired.` : `${fixed} would be repaired. Re-run with --apply.`)
  );

  if (apply && fixed > 0) {
    console.log("  Run points:recompute --apply next, so members pick up their tiers.");
  }
};

main()
  .catch((error: unknown) => {
    console.error("[tiers:backfill]", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
