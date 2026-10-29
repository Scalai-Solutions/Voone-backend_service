import { PointsTransactionKind, PrismaClient, type Clinic } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { OnboardingService } from "../../src/modules/onboarding/onboarding.service";
import { programView } from "../../src/modules/onboarding/runtime/program-view";
import { placeMembersOnProgram } from "../../src/modules/onboarding/runtime/placement";
import catalogFixture from "./reference/sapphira.catalogo.json";

/**
 * A centre that already had members publishes its FIRST programme (decision A7).
 *
 * Nobody may be left without a tier on the new ladder, and nobody loses one. The balances are
 * NOT converted here: how a legacy balance relates to euros of progress is not defined (see
 * scripts/check-legacy-balances.ts), so this step only places, up-only.
 */
const db = new PrismaClient();
const repo = new PrismaCatalogRepository(db);
const service = new OnboardingService(db, repo);

const SLUG = "test-first-activation";
const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

let clinic: Clinic;
let seq = 0;

const wipe = async (): Promise<void> => {
  await db.memberReward.deleteMany({ where: { clinicId: clinic.id } });
  await db.paidVisit.deleteMany({ where: { clinicId: clinic.id } });
  await db.pointsTransaction.deleteMany({ where: { clinicId: clinic.id } });
  await db.member.deleteMany({ where: { clinicId: clinic.id } });
  await db.onboardingProgram.deleteMany({ where: { clinicId: clinic.id } });
  await db.catalogItem.deleteMany({ where: { clinicId: clinic.id } });
};

/** A member as the old scheme left her: a stored balance and perhaps a legacy tier name. */
const legacyMember = async (balance: number, tier: string | null) => {
  seq += 1;

  const member = await db.member.create({
    data: {
      clinicId: clinic.id,
      name: `Antigua ${seq}`,
      phone: `+3469800${String(seq).padStart(4, "0")}`,
      consentMarketing: false,
      consentSource: "staff_entry",
      tier,
      pointsBalance: balance,
      lifetimePoints: balance,
      createdAt: new Date("2025-01-01T00:00:00Z")
    }
  });

  if (balance > 0) {
    await db.pointsTransaction.create({
      data: {
        clinicId: clinic.id,
        memberId: member.id,
        points: balance,
        kind: PointsTransactionKind.EARN,
        idempotencyKey: `first-activation-${member.id}`
      }
    });
  }

  return member;
};

const tierOf = async (id: string) => (await db.member.findUniqueOrThrow({ where: { id } })).tier;

const publishFirst = async () => {
  await repo.replaceForClinic(
    clinic.id,
    (catalogFixture as CatalogItem[]).map((i) => ({
      externalId: i.id,
      name: i.name,
      priceEuro: i.price,
      isProduct: i.product ?? false,
      costPctOverride: i.costPct ?? null,
      estimated: i.estimated ?? false
    }))
  );

  const draft = await service.createDraft(clinic.id, ANSWERS);
  const live = await service.publish(clinic.id, draft.id);

  return programView(live.output as unknown as Program);
};

beforeAll(async () => {
  clinic = await db.clinic.upsert({
    where: { slug: SLUG },
    update: {},
    create: { slug: SLUG, name: "Centro con socias", addressLine: "Calle Tres 3", pincode: "28003" }
  });
});

beforeEach(async () => {
  seq = 0;
  await wipe();
});

afterAll(async () => {
  await wipe();
  await db.clinic.deleteMany({ where: { slug: SLUG } });
  await db.$disconnect();
});

describe("publishing a centre's first programme", () => {
  it("leaves existing members alone: no tier is written, no balance changes", async () => {
    const fresh = await legacyMember(0, null);
    const gold = await legacyMember(500, "Gold");

    await publishFirst();

    // Placement from raw legacy ledger rows read as euros would mis-rank them (500 old points
    // would land on a mid rung), and there is no safe conversion yet (docs D5, undecided).
    expect(await tierOf(fresh.id)).toBeNull();
    expect(await tierOf(gold.id)).toBe("Gold");

    const row = await db.member.findUniqueOrThrow({ where: { id: gold.id } });

    expect(row.pointsBalance).toBe(500);
  });

  it("still places members when a publish REPLACES an earlier programme, up-only", async () => {
    const view = await publishFirst();
    const top = view.tiers[view.tiers.length - 1].label;
    const diamond = await legacyMember(0, top);
    const spender = await legacyMember(20, null);

    const draft = await service.createDraft(clinic.id, { ...ANSWERS, investment: "generoso" });

    await service.publish(clinic.id, draft.id);

    expect(await tierOf(diamond.id)).toBe(top);
    expect(await tierOf(spender.id)).not.toBeNull();
    expect(await placeMembersOnProgram(db, clinic.id)).toMatchObject({ promoted: 0 });
  });
});
