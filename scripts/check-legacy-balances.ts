/**
 * Read-only: how many members each centre has whose points predate its programme, and what
 * the old scheme's points-to-euros relation looks like there.
 *
 * Why it exists. A programme centre keeps progress in euros and shows it x10. A balance earned
 * under the OLD scheme was typed per treatment (ClinicTreatment.pointsAllotted) with no fixed
 * relation to euros, so when a centre activates its first programme that balance is carried
 * as stored and read as euros: a member with 500 old points suddenly shows 5000. Whether to
 * convert, and at what rate, is a product decision this script helps to take; it changes nothing.
 *
 *   npm run programme:check-legacy
 *
 * COUNTS AND AGGREGATES ONLY. It prints a clinic's slug and numbers; never a member's name,
 * phone, email, code or id.
 */

import { OnboardingProgramStatus, PrismaClient } from "@prisma/client";

import { tierKeyOf } from "../src/modules/onboarding/runtime/rules";

const prisma = new PrismaClient();

const range = (values: number[]): string =>
  values.length === 0 ? "n/a" : `${Math.min(...values)}..${Math.max(...values)}`;

const main = async (): Promise<void> => {
  const clinics = await prisma.clinic.findMany({
    select: { id: true, slug: true },
    orderBy: { slug: "asc" }
  });

  console.log("clinic | programme state | counts and aggregates (no personal data)");

  for (const clinic of clinics) {
    const [first, live, members, treatments] = await Promise.all([
      prisma.onboardingProgram.findFirst({
        where: { clinicId: clinic.id, publishedAt: { not: null } },
        orderBy: { publishedAt: "asc" },
        select: { publishedAt: true }
      }),
      prisma.onboardingProgram.count({
        where: { clinicId: clinic.id, status: OnboardingProgramStatus.ACTIVO }
      }),
      prisma.member.findMany({
        where: { clinicId: clinic.id, erasedAt: null },
        select: { id: true, tier: true, pointsBalance: true }
      }),
      prisma.clinicTreatment.findMany({
        where: { clinicId: clinic.id, priceEuro: { gt: 0 } },
        select: { priceEuro: true, pointsAllotted: true }
      })
    ]);

    const withBalance = members.filter((member) => member.pointsBalance > 0);
    const noTier = members.filter((member) => !member.tier).length;
    const legacyTier = members.filter(
      (member) => member.tier && tierKeyOf(member.tier) === null
    ).length;

    // Members who already held points when the first programme went live: the ones whose
    // balance would have been re-read as euros at that moment.
    const predating = first?.publishedAt
      ? await prisma.pointsTransaction
          .groupBy({
            by: ["memberId"],
            where: {
              clinicId: clinic.id,
              createdAt: { lt: first.publishedAt },
              member: { erasedAt: null }
            }
          })
          .then((rows) => rows.length)
      : 0;

    // Old points per euro of price, per treatment: the only evidence of a rate there is.
    const rates = treatments.map(
      (t) => Math.round(((t.pointsAllotted ?? 0) / (t.priceEuro ?? 1)) * 100) / 100
    );
    const balances = withBalance.map((member) => member.pointsBalance);

    console.log(
      [
        clinic.slug,
        live > 0 ? "ACTIVO" : first ? "none live" : "never published",
        `members=${members.length}`,
        `withBalance=${withBalance.length}`,
        `noTier=${noTier}`,
        `legacyTierName=${legacyTier}`,
        `heldPointsBeforeFirstProgramme=${predating}`,
        `balanceSum=${balances.reduce((a, b) => a + b, 0)}`,
        `balanceMax=${balances.length ? Math.max(...balances) : 0}`,
        `treatmentsWithPrice=${treatments.length}`,
        `pointsPerEuro(min..max)=${range(rates)}`,
        `distinctRates=${new Set(rates).size}`
      ].join(" | ")
    );
  }
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
