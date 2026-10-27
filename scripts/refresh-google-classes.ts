/**
 * Re-PATCHes every recorded Google Wallet class from its clinic's template.
 *
 * Why this exists: a class is created once, and `provisionProgram` returns a recorded class
 * without touching Google, so a change to the class's own layout (this release adds the rewards
 * count to the card and the rewards module to the details) never reaches classes that already
 * exist. Saving a clinic's template does it for that clinic from now on; this reaches every other
 * clinic at once, and anything saved before this release.
 *
 * Safe to repeat: it only writes what the template says, so the result does not depend on how many
 * times it has run. A class that fails is reported and the rest are still done.
 *
 *   npm run google:refresh-classes                          # every clinic, report only
 *   npm run google:refresh-classes -- --apply               # actually PATCH Google
 *   npm run google:refresh-classes -- --clinic <id> --apply
 */

import "dotenv/config";

import { prisma } from "../src/infrastructure/database/prisma-client";
import { refreshGoogleClasses } from "../src/modules/wallet-refresh/google-class-refresh";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const clinicFlag = args.indexOf("--clinic");
const clinicId = clinicFlag >= 0 ? args[clinicFlag + 1] : undefined;

const main = async (): Promise<void> => {
  const result = await refreshGoogleClasses({ clinicId, apply });

  console.log(
    `${result.found} recorded Google class${result.found === 1 ? "" : "es"}` +
      (clinicId ? ` for clinic ${clinicId}` : "") +
      "."
  );

  if (apply) {
    console.log(`Refreshed ${result.refreshed}, failed ${result.failed}.`);
  } else {
    console.log("Dry run: nothing was written. Re-run with --apply to PATCH Google.");
  }

  if (result.failed > 0) process.exitCode = 1;
};

main()
  .catch((error: unknown) => {
    console.error("Google class refresh failed:", error instanceof Error ? error.name : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
