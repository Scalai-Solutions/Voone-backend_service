/**
 * Gives every existing member the five-character code now printed on their card.
 *
 * Member.code arrived nullable, because a column cannot be both required and absent from
 * rows that already exist. Until this runs, a member who signed up earlier falls back to
 * the 49-character pass serial on the back of their card — see apple-pass.fields.ts.
 *
 * Generates in TypeScript rather than in the migration's SQL so there is exactly one
 * generator and one alphabet. A second implementation in SQL would be free to drift, and
 * the thing it would drift on is which characters a person can read aloud.
 *
 *   npm run members:backfill-codes                       # report only
 *   npm run members:backfill-codes -- --apply            # write, and refresh passes
 *   npm run members:backfill-codes -- --apply --no-sync  # write only
 *
 * Safe to re-run: members who already have a code are skipped, never reassigned. A code
 * is printed on a card a member is holding, so changing one is not a backfill.
 *
 * Writing the column is NOT enough to get the code onto a phone. A device asks for
 * "serials updated since <t>", which serialsUpdatedSince answers from
 * WalletObject.lastSyncedAt — a column this script does not touch. So an installed pass
 * would keep showing the old back indefinitely, and not even an APNs push would fix it,
 * because the device's follow-up query would come back empty. Hence the sync.
 */

import { PrismaClient } from "@prisma/client";

import { isUniqueViolation } from "../src/common/utils/prisma-errors";
import { generateMemberCode } from "../src/common/utils/short-code";
import { buildWalletSyncQueue } from "../src/wallet/wallet.composition";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const apply = args.includes("--apply");

/** For a run that only wants the column written — a large backfill split from its sync. */
const skipSync = args.includes("--no-sync");

/** Mirrors withMemberCode. Not shared with it because that one wraps a create. */
const ATTEMPTS = 5;

const assignCode = async (memberId: string): Promise<string | null> => {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const code = generateMemberCode();

    try {
      await prisma.member.update({ where: { id: memberId }, data: { code } });

      return code;
    } catch (error) {
      if (!isUniqueViolation(error, ["clinicId", "code"]) || attempt === ATTEMPTS) {
        throw error;
      }
    }
  }

  return null;
};

const main = async (): Promise<void> => {
  // Erased members included deliberately. An erasure tombstones the row rather than
  // deleting it, precisely so the ledger keeps its references — and a row without a code
  // would be the one row a clinic-scoped unique index cannot describe.
  const pending = await prisma.member.findMany({
    where: { code: null },
    select: { id: true, clinicId: true, name: true },
    orderBy: { createdAt: "asc" }
  });

  const total = await prisma.member.count();

  if (pending.length === 0) {
    console.log(`  ${total} member(s), all of them already have a code. Nothing to do.`);

    return;
  }

  const assigned: string[] = [];

  for (const member of pending) {
    if (!apply) {
      console.log(`  ${member.clinicId}  ${member.name}: would get a code`);
      continue;
    }

    const code = await assignCode(member.id);

    if (!code) {
      console.log(`  ${member.clinicId}  ${member.name}: no free code after ${ATTEMPTS} tries`);
      continue;
    }

    console.log(`  ${member.clinicId}  ${member.name}: ${code}`);
    assigned.push(member.id);
  }

  console.log(
    `\n  ${total} member(s), ${pending.length} without a code, ` +
      (apply ? `${assigned.length} assigned.` : "none written. Re-run with --apply.")
  );

  if (apply && assigned.length > 0) {
    await refreshPasses(assigned);
  }
};

/**
 * Rebuilds each member's pass, so the code reaches the card rather than only the column.
 *
 * Reports rather than throws when no queue is configured: the column is written either
 * way, and a run that cannot reach Redis should say the passes are stale, not undo its
 * own work.
 */
const refreshPasses = async (memberIds: string[]): Promise<void> => {
  if (skipSync) {
    console.log(`  --no-sync: ${memberIds.length} pass(es) still show the old back.`);
    console.log("  Re-run without --no-sync, or credit each member, to refresh them.");

    return;
  }

  const wallets = buildWalletSyncQueue(prisma);

  if (!wallets) {
    console.log("  No wallet sync configured, so no pass was refreshed.");
    console.log("  Set CARD_REDEMPTION_SECRET (and WALLET_SYNC_MODE) and re-run.");

    return;
  }

  let synced = 0;

  for (const memberId of memberIds) {
    try {
      await wallets.enqueueMemberSync(memberId);
      synced += 1;
    } catch (error) {
      // One member's wallet failing must not abandon the rest: the column is already
      // written, and a missed sync is recoverable by re-running.
      console.log(`  ${memberId}: sync failed — ${(error as Error).message}`);
    }
  }

  await wallets.close();

  console.log(`  ${synced} of ${memberIds.length} pass(es) queued for refresh.`);
};

main()
  .catch((error: unknown) => {
    console.error("[members:backfill-codes]", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
