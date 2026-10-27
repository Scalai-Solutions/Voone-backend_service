/**
 * Lists the clinic templates whose benefitsText / infoText is longer than a card can hold.
 *
 * Read-only: it changes nothing. The card schema caps both texts at 500 and the template schema
 * used to allow 1200, so a template saved in between can hold a text the card refuses (the
 * assembler now clips it, but the clinic should still be told to shorten it).
 *
 *   npm run wallet:check-text-length
 *
 * Prints counts and clinic ids only, never the text.
 */

import { PrismaClient } from "@prisma/client";

import { findOverlongWalletTexts } from "../src/modules/templates/wallet-text-audit";
import { CARD_TEXT_MAX_LENGTH } from "../src/wallet/engine/card-text";

const prisma = new PrismaClient();

const main = async (): Promise<void> => {
  const rows = await prisma.clinicTemplate.findMany({
    select: { clinicId: true, benefitsText: true, infoText: true }
  });
  const report = findOverlongWalletTexts(rows);

  console.log(`Templates checked: ${rows.length} (limit ${CARD_TEXT_MAX_LENGTH} characters)`);
  console.log(`benefitsText over the limit: ${report.benefitsOver}`);
  console.log(`infoText over the limit: ${report.infoOver}`);

  for (const clinic of report.clinics) {
    const fields = [clinic.benefits ? "benefitsText" : "", clinic.info ? "infoText" : ""]
      .filter(Boolean)
      .join(", ");
    console.log(`  clinic ${clinic.clinicId}: ${fields}`);
  }

  if (report.clinics.length > 0) process.exitCode = 1;
};

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
