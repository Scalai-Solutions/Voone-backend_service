/**
 * Rebuilds Member.pointsBalance and Member.tier from the ledger.
 *
 * The cached columns exist so that rendering a wallet pass does not sum a member's whole
 * history. A cache with no rebuild path is a liability, and there are three ordinary
 * reasons this one drifts:
 *
 * - A clinic's tier scale changes. Every member's cached tier is then computed against
 *   thresholds that no longer exist, and nothing in the write path revisits them.
 * - A process dies between appending to the ledger and writing the cache. The ledger is
 *   correct and the cache is a version behind.
 * - A backfill or an import writes ledger rows directly.
 *
 * Safe to run at any time and as often as you like: it only ever writes values derived
 * from the ledger, which is append-only, so the result does not depend on when it runs
 * or on how many times it has run before.
 *
 *   npm run points:recompute                 # every member, report only
 *   npm run points:recompute -- --apply      # actually write
 *   npm run points:recompute -- --clinic <id> --apply
 */

import { PrismaClient } from "@prisma/client";

import {
  PrismaMemberPointsCache,
  PrismaPointsLedgerRepository
} from "../src/modules/points/prisma-points-ledger.repository";
import { tierFor, type TierDefinition } from "../src/modules/points/tier-engine";
import { PrismaProgramTierPort } from "../src/modules/onboarding/runtime/program-tier.port";

const prisma = new PrismaClient();
const ledger = new PrismaPointsLedgerRepository(prisma);
const cache = new PrismaMemberPointsCache(prisma);
const programTiers = new PrismaProgramTierPort(prisma);

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const clinicFlag = args.indexOf("--clinic");
const onlyClinic = clinicFlag >= 0 ? args[clinicFlag + 1] : undefined;

const main = async (): Promise<void> => {
  const members = await prisma.member.findMany({
    where: {
      erasedAt: null,
      ...(onlyClinic ? { clinicId: onlyClinic } : {})
    },
    select: { id: true, clinicId: true, pointsBalance: true, lifetimePoints: true, tier: true }
  });

  // One scale per clinic rather than per member: a clinic with a thousand members would
  // otherwise read the same three rows a thousand times.
  const scales = new Map<string, TierDefinition[]>();
  let drifted = 0;

  for (const member of members) {
    let scale = scales.get(member.clinicId);

    if (!scale) {
      scale = await ledger.tierScaleFor(member.clinicId);
      scales.set(member.clinicId, scale);
    }

    const balance = await ledger.balanceFor(member.id);

    // A clinic on an onboarding programme is ranked by it — thresholds AND tenure — and NOT by
    // the legacy scale, which would put every such member in whatever tier the old template
    // happens to read as. Demotion is allowed here, deliberately: this script derives the tier
    // from the ledger and the sign-up date, so a tier that does not follow from them is exactly
    // the drift it exists to repair. "Tiers are not lost" is a rule about ordinary movements.
    const programme = await programTiers.resolve({
      memberId: member.id,
      clinicId: member.clinicId,
      lifetime: balance.lifetime,
      current: member.tier,
      allowDemotion: true
    });
    const tier = programme ? programme.tier : tierFor(balance.lifetime, scale);
    const tierCode = tier?.code ?? null;

    if (
      member.pointsBalance === balance.spendable &&
      member.lifetimePoints === balance.lifetime &&
      member.tier === tierCode
    ) {
      continue;
    }

    drifted += 1;
    console.log(
      `  ${member.id}  points ${member.pointsBalance} -> ${balance.spendable}` +
        `  lifetime ${member.lifetimePoints} -> ${balance.lifetime}` +
        `  tier ${member.tier ?? "none"} -> ${tierCode ?? "none"}`
    );

    if (apply) {
      await cache.write(member.id, balance, tierCode);
    }
  }

  console.log(
    `\n  ${members.length} member(s) checked, ${drifted} drifted` +
      (apply ? " and corrected." : ". Re-run with --apply to write.")
  );
};

main()
  .catch((error: unknown) => {
    console.error("[points:recompute]", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
