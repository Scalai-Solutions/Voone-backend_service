/**
 * Empties the shared message list of every recorded Google Wallet class.
 *
 * Why this exists: broadcasts used to be one class message shown on every card, kept up to four at
 * a time. They now go to each card's own list, which keeps the newest two of any kind. The old
 * class messages would otherwise stay on every card beside those two, forever.
 *
 * Safe to repeat: a class with no messages is not written.
 *
 *   npm run google:clear-class-messages                 # report only
 *   npm run google:clear-class-messages -- --apply      # actually PATCH Google
 */

import "dotenv/config";

import { WalletProviderType } from "@prisma/client";

import { prisma } from "../src/infrastructure/database/prisma-client";
import { clearClassMessages } from "../src/wallet/providers/google/classService";

const apply = process.argv.slice(2).includes("--apply");

const main = async (): Promise<void> => {
  const classes = await prisma.walletClass.findMany({
    where: { provider: WalletProviderType.GOOGLE },
    select: { externalClassId: true }
  });
  let messages = 0;
  let failed = 0;

  for (const { externalClassId } of classes) {
    try {
      messages += await clearClassMessages(externalClassId, apply);
    } catch (error) {
      failed += 1;
      console.error(`Failed: ${externalClassId}`, error instanceof Error ? error.name : error);
    }
  }

  console.log(
    `${classes.length} Google class(es), ${messages} shared message(s) ${apply ? "removed" : "found"}, ${failed} failed.`
  );
  if (!apply) console.log("Dry run: nothing was written. Re-run with --apply to PATCH Google.");
  if (failed > 0) process.exitCode = 1;
};

main()
  .catch((error: unknown) => {
    console.error("Clearing class messages failed:", error instanceof Error ? error.name : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
