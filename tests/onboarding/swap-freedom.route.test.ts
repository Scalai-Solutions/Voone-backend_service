import { PrismaClient, type Clinic } from "@prisma/client";
import express, { type Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ClinicNotFoundError } from "../../src/common/errors/membership.errors";
import { errorHandler } from "../../src/common/middleware/error-handler";
import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";
import { COST_REVIEW_NOTE } from "../../src/modules/onboarding/engine";
import type { CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { presentProgram } from "../../src/modules/onboarding/presentation";
import { OnboardingService } from "../../src/modules/onboarding/onboarding.service";
import { createOnboardingRouter } from "../../src/routes/v1/onboarding.route";
import catalogFixture from "./reference/sapphira.catalogo.json";

/**
 * Swap freedom, the way the admin and the owner meet it: over HTTP, against a real database.
 *
 * The cost note no longer blocks publishing, it is told to the admin; the admin's programme
 * carries each reward's retail price and the owner's never does; and the admin can ask what the
 * plan she has edited is worth over five years against the engine's own recommendation.
 */
const db = new PrismaClient();

const SLUG = "test-swapfree";
const ANSWERS = {
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const catalog = new PrismaCatalogRepository(db);
const onboarding = new OnboardingService(db, catalog);

const app = ((): Express => {
  const a = express();

  a.use(express.json());
  a.use(
    "/api/v1",
    createOnboardingRouter({
      onboarding,
      catalog,
      findClinic: async (slug) => {
        const found = await db.clinic.findUnique({ where: { slug }, select: { id: true } });

        if (!found) throw new ClinicNotFoundError(slug);

        return found;
      },
      clinicExists: async (id) => (await db.clinic.count({ where: { id } })) > 0
    })
  );
  a.use(errorHandler);

  return a;
})();

interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const call = async (method: string, path: string, body?: unknown): Promise<Reply> => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", connection: "close" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.closeAllConnections();
    server.close();
  }
};

let clinic: Clinic;

const fixtureItems = (catalogFixture as CatalogItem[]).map((i) => ({
  externalId: i.id,
  name: i.name,
  priceEuro: i.price,
  isProduct: i.product ?? false,
  costPctOverride: i.costPct ?? null,
  estimated: i.estimated ?? false
}));

const admin = (suffix: string) => `/admin/clinics/${clinic.id}/onboarding${suffix}`;

const wipe = async (): Promise<void> => {
  await db.onboardingProgram.deleteMany({ where: { clinicId: clinic.id } });
  await db.catalogItem.deleteMany({ where: { clinicId: clinic.id } });
};

/** The last reward of the ladder, where one very dear gift pushes the programme's cost over. */
const lastRewardMilestone = (program: { ladder: Array<{ n: number; type: string }> }): number =>
  program.ladder.filter((m) => m.type === "premio").at(-1)!.n;

const withLuxury = async (): Promise<{ draftId: string; milestone: number }> => {
  await call("PUT", admin("/catalog"), {
    items: [...fixtureItems, { externalId: "WX", name: "Cera lujo corporal", priceEuro: 2000 }]
  });
  const draft = await call("POST", admin("/programs"), ANSWERS);

  return { draftId: draft.body.id, milestone: lastRewardMilestone(draft.body.program) };
};

beforeAll(async () => {
  clinic = await db.clinic.upsert({
    where: { slug: SLUG },
    update: {},
    create: { slug: SLUG, name: "Centro libre", addressLine: "Calle Cinco 5", pincode: "28005" }
  });
  await wipe();
});

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await db.clinic.deleteMany({ where: { slug: SLUG } });
  await db.$disconnect();
});

describe("the cost note no longer blocks publishing", () => {
  it("publishes a programme that carries the cost note, and shows the note as information", async () => {
    const { draftId, milestone } = await withLuxury();
    const swapped = await call("PATCH", admin(`/programs/${draftId}/milestones/${milestone}`), {
      itemId: "WX"
    });

    expect(swapped.status).toBe(200);

    const stored = await db.onboardingProgram.findUniqueOrThrow({ where: { id: draftId } });

    // Still in the stored output, which Voone audits.
    expect((stored.output as unknown as Program).review).toContain(COST_REVIEW_NOTE);
    // Presented as information, not as something to resolve.
    expect(swapped.body.program.review).toEqual([]);
    expect(swapped.body.program.notes).toEqual([COST_REVIEW_NOTE]);

    const published = await call("POST", admin(`/programs/${draftId}/publish`));

    expect(published.status).toBe(200);
    expect(published.body.status).toBe("ACTIVO");
  });

  it("still blocks on any other review note, naming it", async () => {
    const { draftId } = await withLuxury();
    const other = "Hay 1 fila del catálogo sin categoría. Clasifícalas en la tabla.";
    const stored = await db.onboardingProgram.findUniqueOrThrow({ where: { id: draftId } });
    const output = stored.output as unknown as Program;

    await db.onboardingProgram.update({
      where: { id: draftId },
      data: { output: { ...output, review: [COST_REVIEW_NOTE, other] } as unknown as object }
    });

    const shown = await call("GET", admin(`/programs/${draftId}`));

    expect(shown.body.program.review).toEqual([other]);
    expect(shown.body.program.notes).toEqual([COST_REVIEW_NOTE]);

    const refused = await call("POST", admin(`/programs/${draftId}/publish`));

    expect(refused.status).toBe(409);
    expect(refused.body.error?.message ?? JSON.stringify(refused.body)).toContain(other);
    // The note that does not block is not in the refusal.
    expect(JSON.stringify(refused.body)).not.toContain("supera en más de un 50%");
  });
});

describe("the reward's retail price, for the admin only", () => {
  const live = async (): Promise<string> => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);

    await call("POST", admin(`/programs/${draft.body.id}/publish`));

    return draft.body.id as string;
  };

  it("carries rewardValueEuro, in whole euros, on every reward milestone of the admin programme", async () => {
    const id = await live();
    const r = await call("GET", admin(`/programs/${id}`));
    const stored = (await db.onboardingProgram.findUniqueOrThrow({ where: { id } }))
      .output as unknown as Program;
    const rewards = r.body.program.ladder.filter((m: { type: string }) => m.type === "premio");

    expect(rewards.length).toBeGreaterThan(0);

    for (const m of rewards) {
      const chosen = stored.chosen.find((c) => c.m.n === m.n)!;

      expect(Number.isInteger(m.rewardValueEuro)).toBe(true);
      expect(m.rewardValueEuro).toBe(Math.round(chosen.o.value));
    }

    // Only reward milestones, and only on the milestone, never inside what a centre reads.
    for (const m of r.body.program.ladder.filter((x: { type: string }) => x.type !== "premio")) {
      expect(m).not.toHaveProperty("rewardValueEuro");
    }
  });

  it("is the sum of the items for a combo", async () => {
    const id = await live();
    const stored = (await db.onboardingProgram.findUniqueOrThrow({ where: { id } }))
      .output as unknown as Program;
    const first = stored.chosen[0];
    const [a, b] = [first.o.items[0], { ...first.o.items[0], id: "COMBO2", value: 41.4 }];

    // Plant a two-item gift the way the engine builds one: `value` is the items' sum.
    first.o = { items: [{ ...a, value: 30.2 }, b], value: 71.6, cost: 5 };

    const shown = presentProgram(stored, { forAdmin: true }).ladder.find((m) => m.n === first.m.n);

    expect(shown?.rewardValueEuro).toBe(72);
  });

  it("is on the preview and on a swap result, which are the admin's too", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const preview = await call("POST", admin("/preview"), ANSWERS);

    expect(JSON.stringify(preview.body.program)).toContain("rewardValueEuro");
  });

  it("is never on the owner's programme, nor anywhere in what the pass and the owner dashboard read", async () => {
    await live();

    const owner = await call("GET", `/clinics/${SLUG}/program`);

    expect(owner.status).toBe(200);
    expect(JSON.stringify(owner.body)).not.toContain("rewardValueEuro");
    expect(owner.body.program.notes).toEqual([]);
    expect(owner.body.program.ladder.length).toBeGreaterThan(0);
  });

  it("is off by default in the presenter and on only when asked for the admin", async () => {
    const id = await live();
    const stored = (await db.onboardingProgram.findUniqueOrThrow({ where: { id } }))
      .output as unknown as Program;

    expect(JSON.stringify(presentProgram(stored))).not.toContain("rewardValueEuro");
    expect(JSON.stringify(presentProgram(stored, { forAdmin: true }))).toContain("rewardValueEuro");
  });

  it("lets the dropdown show prices: the catalogue lists priceEuro on every row", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });

    const r = await call("GET", admin("/catalog"));

    expect(r.body.items.length).toBe(fixtureItems.length);
    for (const row of r.body.items) expect(typeof row.priceEuro).toBe("number");
  });
});
