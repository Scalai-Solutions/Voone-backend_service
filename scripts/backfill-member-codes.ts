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
 *   npm run members:backfill-codes              # report only
 *   npm run members:backfill-codes -- --apply   # write
 *
 * Safe to re-run: members who already have a code are skipped, never reassigned. A code
 * is printed on a card a member is holding, so changing one is not a backfill.
 */

import { PrismaClient } from "@prisma/client";

import { isUniqueViolation } from "../src/common/utils/prisma-errors";
import { generateMemberCode } from "../src/common/utils/short-code";

const prisma = new PrismaClient();
const apply = process.argv.slice(2).includes("--apply");

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

  let assigned = 0;

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
    assigned += 1;
  }

  console.log(
    `\n  ${total} member(s), ${pending.length} without a code, ` +
      (apply ? `${assigned} assigned.` : "none written. Re-run with --apply.")
  );

  if (apply && assigned > 0) {
    // The code is a field on the pass, so a card already installed shows the old back
    // until it refreshes.
    console.log("  Members' passes pick the code up on their next wallet sync.");
  }
};

main()
  .catch((error: unknown) => {
    console.error("[members:backfill-codes]", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
