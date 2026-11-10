/**
 * Counts the gifts members have ALREADY redeemed towards their savings total.
 *
 * Why this exists: the savings total starts at the first redemption after this release, so a member
 * who redeemed a gift last month would show nothing. This writes a GIFT saving for each redeemed
 * ladder reward whose stored detail carries a retail value, then sets each member's cached total
 * from the sum of their rows. Gifts only, on purpose: nothing else was recorded with an amount, and
 * a discount or a perk is never reconstructed by guessing. A reward issued before it carried its
 * value (recurring and referral rewards) counts nothing, for the same reason.
 *
 * Safe to repeat: a row is keyed by its reward, so a second run adds nothing, and the cached total
 * is SET from the rows rather than incremented.
 *
 *   npm run savings:backfill                          # every clinic, report only
 *   npm run savings:backfill -- --apply               # actually write
 *   npm run savings:backfill -- --clinic <id> --apply
 */

import "dotenv/config";

import { prisma } from "../src/infrastructure/database/prisma-client";
import { backfillSavings } from "../src/modules/onboarding/runtime/savings-backfill";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const clinicFlag = args.indexOf("--clinic");
const clinicId = clinicFlag >= 0 ? args[clinicFlag + 1] : undefined;

const main = async (): Promise<void> => {
  const result = await backfillSavings(prisma, { clinicId, apply });

  console.log(
    `${result.counted} redeemed gift${result.counted === 1 ? "" : "s"} for ${result.members} member${result.members === 1 ? "" : "s"}` +
      `, ${(result.cents / 100).toFixed(2)} € in all` +
      (clinicId ? ` (clinic ${clinicId})` : "") +
      `; ${result.skipped} redeemed without a stored value, not counted.`
  );

  if (apply) {
    console.log(`Wrote the totals of ${result.written} member${result.written === 1 ? "" : "s"}.`);
  } else {
    console.log("Dry run: nothing was written. Re-run with --apply to write.");
  }
};

main()
  .catch((error: unknown) => {
    console.error("Savings backfill failed:", error instanceof Error ? error.name : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
