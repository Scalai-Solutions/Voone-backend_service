/**
 * Writes ledger rows for balances that predate the ledger.
 *
 * Before PR #37, POST /clinics/:slug/members/:memberId/points incremented
 * Member.pointsBalance directly. Those movements never produced a PointsTransaction, so
 * the cached column and the ledger disagree — and `npm run points:recompute` rebuilds
 * that column FROM the ledger, which means running the reconciliation tool would erase
 * every point credited that way.
 *
 * This closes the gap by recording, per member, one ADJUSTMENT for the difference. After
 * it, the ledger explains the balance and recompute becomes safe again.
 *
 * ADJUSTMENT rather than EARN on purpose: it is honest about what the row is — a
 * correction made by us, not a visit the member made — and it still counts towards
 * lifetime, so tiers land where they should once VOO-4's thresholds are seeded.
 *
 * The idempotency key is derived from the member, so running this twice is a no-op
 * rather than a doubling. That matters more than usual here: this touches real balances.
 *
 *   npm run points:backfill              # report only
 *   npm run points:backfill -- --apply   # write
 */

import { PointsTransactionKind, PrismaClient } from "@prisma/client";

import { projectBalance } from "../src/modules/points/points-balance";

const prisma = new PrismaClient();
const apply = process.argv.slice(2).includes("--apply");

/** Stable per member, so a second run collides with the first and writes nothing. */
const keyFor = (memberId: string): string => `backfill:pre-ledger:${memberId}`;

const main = async (): Promise<void> => {
  const members = await prisma.member.findMany({
    where: { erasedAt: null },
    select: {
      id: true,
      name: true,
      clinicId: true,
      pointsBalance: true,
      pointsLedger: { select: { points: true, kind: true } }
    }
  });

  let written = 0;
  let skipped = 0;
  const anomalies: string[] = [];

  for (const member of members) {
    const ledger = projectBalance(member.pointsLedger);
    const difference = member.pointsBalance - ledger.spendable;

    if (difference === 0) {
      skipped += 1;
      continue;
    }

    if (difference < 0) {
      // The ledger says MORE than the cache. Not something this script should quietly
      // "fix" by inventing a negative row: it means the cache is stale, which is what
      // points:recompute is for. Reported and left alone.
      anomalies.push(
        `  ${member.id}  ${member.name}: ledger ${ledger.spendable} > cache ${member.pointsBalance}. ` +
          `Run points:recompute instead — nothing written here.`
      );
      continue;
    }

    console.log(
      `  ${member.id}  ${member.name.padEnd(22)} cache=${member.pointsBalance} ledger=${ledger.spendable} -> writing +${difference}`
    );

    if (apply) {
      try {
        await prisma.pointsTransaction.create({
          data: {
            memberId: member.id,
            clinicId: member.clinicId,
            points: difference,
            kind: PointsTransactionKind.ADJUSTMENT,
            reason: "Saldo anterior al libro de puntos",
            idempotencyKey: keyFor(member.id)
          }
        });
        written += 1;
      } catch (error) {
        // A unique violation means this member was already backfilled. Expected on a
        // re-run and not a failure.
        console.log(`    already backfilled, skipping (${(error as Error).name})`);
      }
    }
  }

  if (anomalies.length > 0) {
    console.log("\nAnomalies — NOT written:");
    anomalies.forEach((line) => console.log(line));
  }

  console.log(
    `\n  ${members.length} member(s) checked, ${skipped} already consistent, ` +
      (apply ? `${written} backfilled.` : "nothing written. Re-run with --apply.")
  );

  if (apply) {
    console.log("  points:recompute is now safe to run.");
  }
};

main()
  .catch((error: unknown) => {
    console.error("[points:backfill]", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
