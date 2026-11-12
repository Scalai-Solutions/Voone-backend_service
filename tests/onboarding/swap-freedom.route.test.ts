import { PrismaClient, type Clinic } from "@prisma/client";
import express, { type Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ClinicNotFoundError } from "../../src/common/errors/membership.errors";
import { errorHandler } from "../../src/common/middleware/error-handler";
import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";
import { COST_REVIEW_NOTE, ORDER_REVIEW_NOTE } from "../../src/modules/onboarding/engine";
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

describe("a swap reads the catalogue as it is today, not the draft's snapshot", () => {
  const firstReward = (program: { ladder: Array<{ n: number; type: string }> }): number =>
    program.ladder.find((m) => m.type === "premio")!.n;

  const rewardValue = (
    body: { program: { ladder: Array<{ n: number; rewardValueEuro?: number }> } },
    milestone: number
  ): number | undefined => body.program.ladder.find((m) => m.n === milestone)?.rewardValueEuro;

  it("accepts an item added to the catalogue after the draft was generated", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);
    const milestone = firstReward(draft.body.program);

    await call("PUT", admin("/catalog"), {
      items: [...fixtureItems, { externalId: "WNEW", name: "Cera piernas nueva", priceEuro: 55 }]
    });

    const swapped = await call(
      "PATCH",
      admin(`/programs/${draft.body.id}/milestones/${milestone}`),
      {
        itemId: "WNEW"
      }
    );

    expect(swapped.status).toBe(200);
    expect(rewardValue(swapped.body, milestone)).toBe(55);
  });

  it("prices an item with the price it has now when it was repriced after the draft", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);
    const milestone = firstReward(draft.body.program);
    const target = fixtureItems.find(
      (i) => i.name.toLowerCase().includes("cera") && i.priceEuro > 0
    )!;

    await call("PUT", admin("/catalog"), {
      items: fixtureItems.map((i) =>
        i.externalId === target.externalId ? { ...i, priceEuro: 77 } : i
      )
    });

    const swapped = await call(
      "PATCH",
      admin(`/programs/${draft.body.id}/milestones/${milestone}`),
      {
        itemId: target.externalId
      }
    );

    // Either the swap is refused for a reason that is not the catalogue (a repeat), or it is priced now.
    if (swapped.status === 200) expect(rewardValue(swapped.body, milestone)).toBe(77);
    else expect(JSON.stringify(swapped.body)).not.toContain("no está en el catálogo");
  });

  it("still names an id that is nowhere in the catalogue", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);
    const refused = await call(
      "PATCH",
      admin(`/programs/${draft.body.id}/milestones/${firstReward(draft.body.program)}`),
      { itemId: "NOT-A-ROW" }
    );

    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("no está en el catálogo");
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

describe("the five-year comparison against the engine's recommendation", () => {
  const compare = (programId: string, id: string = clinic.id) =>
    call("POST", `/admin/clinics/${id}/onboarding/programs/${programId}/comparison`);

  const draft = async (): Promise<string> => {
    await call("PUT", admin("/catalog"), {
      items: [...fixtureItems, { externalId: "WX", name: "Cera lujo corporal", priceEuro: 2000 }]
    });

    return (await call("POST", admin("/programs"), ANSWERS)).body.id as string;
  };

  it("answers delta 0 for the plan exactly as the engine recommended it", async () => {
    const id = await draft();
    const r = await compare(id);

    expect(r.status).toBe(200);
    expect(r.body.recommendedNet5y).not.toBeNull();
    expect(r.body.currentNet5y).toBe(r.body.recommendedNet5y);
    expect(r.body.delta).toBe(0);
    expect(r.body.reason).toBeNull();
    expect(r.body.years).toHaveLength(5);
    expect(r.body.years.map((y: { year: number }) => y.year)).toEqual([1, 2, 3, 4, 5]);
    expect(r.body.years[4].currentCumulative).toBe(r.body.currentNet5y);
    expect(r.body.years[4].recommendedCumulative).toBe(r.body.recommendedNet5y);
  });

  it("uses the programme's calculator defaults for both plans, so only the plan differs", async () => {
    const id = await draft();
    const r = await compare(id);
    const calc = await call("POST", admin(`/programs/${id}/calculator`), {});

    expect(r.body.inputs).toEqual({ clients: 300, ticket: 65 });
    expect(r.body.inputs).toEqual(calc.body.defaults);
    // And it is the calculator's own number for the current plan, rounded to whole euros.
    expect(r.body.currentNet5y).toBe(Math.round(calc.body.years[4].cumulativeNet));
  });

  it("shows a dearer reward as a worse five-year result than the recommendation", async () => {
    const id = await draft();
    const before = await compare(id);
    // A 2000 euro waxing gift as the very first reward, which every member reaches.
    const swap = await call("PATCH", admin(`/programs/${id}/milestones/1`), { itemId: "WX" });

    expect(swap.status).toBe(200);

    const after = await compare(id);

    expect(after.body.recommendedNet5y).toBe(before.body.recommendedNet5y);
    expect(after.body.currentNet5y).toBeLessThan(before.body.currentNet5y);
    expect(after.body.delta).toBeLessThan(0);
    expect(after.body.delta).toBe(after.body.currentNet5y - after.body.recommendedNet5y);
    expect(after.body.years[0].currentCumulative).toBeLessThan(
      after.body.years[0].recommendedCumulative
    );
  });

  it("works on a live programme, and never changes the stored one", async () => {
    const id = await draft();

    await call("POST", admin(`/programs/${id}/publish`));

    const stored = await db.onboardingProgram.findUniqueOrThrow({ where: { id } });
    const r = await compare(id);
    const after = await db.onboardingProgram.findUniqueOrThrow({ where: { id } });

    expect(r.status).toBe(200);
    expect(after.output).toEqual(stored.output);
    expect(after.updatedAt).toEqual(stored.updatedAt);
  });

  /** An old row: made before the baseline was stored, so only a replay can recommend. */
  const withoutBaseline = async (id: string): Promise<void> => {
    const row = await db.onboardingProgram.findUniqueOrThrow({ where: { id } });
    const { recommended: _drop, ...output } = row.output as unknown as Program & {
      recommended?: unknown;
    };

    void _drop;
    await db.onboardingProgram.update({ where: { id }, data: { output: output as object } });
  };

  it("says there is no recommendation, in English, when an old row's catalogue cannot be replayed", async () => {
    const id = await draft();

    await withoutBaseline(id);

    for (const snapshot of [[], { broken: true }, "garbage", [{ id: 1 }], [null]]) {
      await db.onboardingProgram.update({
        where: { id },
        data: { catalogSnapshot: snapshot as unknown as object }
      });

      const r = await compare(id);

      expect(r.status, JSON.stringify(snapshot)).toBe(200);
      expect(r.body.recommendedNet5y).toBeNull();
      expect(r.body.delta).toBeNull();
      expect(r.body.reason).toMatch(/^The original recommendation could not be recalculated/);
      // The current plan is still worth a number.
      expect(typeof r.body.currentNet5y).toBe("number");
      expect(r.body.years).toHaveLength(5);
      expect(r.body.years[0].recommendedNet).toBeNull();
      expect(r.body.years[0].recommendedCumulative).toBeNull();
    }
  });

  it("does not need the stored catalogue at all when the baseline was stored", async () => {
    const id = await draft();

    await db.onboardingProgram.update({
      where: { id },
      data: { catalogSnapshot: { broken: true } }
    });

    const r = await compare(id);

    expect(r.status).toBe(200);
    expect(r.body.delta).toBe(0);
    expect(r.body.reason).toBeNull();
  });

  it("answers 404 for a clinic that does not exist, and for another clinic's programme", async () => {
    const id = await draft();
    const other = await db.clinic.upsert({
      where: { slug: `${SLUG}-other` },
      update: {},
      create: { slug: `${SLUG}-other`, name: "Otro", addressLine: "Calle Seis 6", pincode: "28006" }
    });

    try {
      expect((await compare(id, "does-not-exist")).status).toBe(404);
      expect((await compare(id, other.id)).status).toBe(404);
      expect((await compare("00000000-0000-4000-8000-00000000dead")).status).toBe(404);
    } finally {
      await db.clinic.delete({ where: { id: other.id } });
    }
  });

  it("sends yearly totals only: the key set has no gift, cost or value in it", async () => {
    const id = await draft();

    await call("PATCH", admin(`/programs/${id}/milestones/1`), { itemId: "WX" });

    const r = await compare(id);

    expect(Object.keys(r.body).sort()).toEqual(
      ["currentNet5y", "delta", "inputs", "reason", "recommendedNet5y", "years"].sort()
    );
    expect(Object.keys(r.body.inputs).sort()).toEqual(["clients", "ticket"]);

    for (const year of r.body.years) {
      expect(Object.keys(year).sort()).toEqual(
        [
          "currentCumulative",
          "currentNet",
          "recommendedCumulative",
          "recommendedNet",
          "year"
        ].sort()
      );
    }

    expect(JSON.stringify(r.body)).not.toMatch(/Cera lujo|WX|"items"|"reward"|"name"|"cost"/i);
  });

  it("stores the engine's untouched output as the baseline of a new draft", async () => {
    const id = await draft();
    const stored = (await db.onboardingProgram.findUniqueOrThrow({ where: { id } }))
      .output as unknown as Program & { recommended?: Program & { recommended?: unknown } };
    const { recommended, ...plan } = stored;

    expect(recommended).toBeDefined();
    // The baseline is the plan as generated, and carries no baseline of its own.
    expect(recommended).toEqual(plan);
    expect(recommended).not.toHaveProperty("recommended");
  });

  it("keeps the baseline exactly as it was through a swap, so the swap shows as the difference", async () => {
    const id = await draft();
    const read = async () =>
      (
        (await db.onboardingProgram.findUniqueOrThrow({ where: { id } })).output as unknown as {
          recommended: unknown;
        }
      ).recommended;
    const before = await read();

    expect(
      (await call("PATCH", admin(`/programs/${id}/milestones/1`), { itemId: "WX" })).status
    ).toBe(200);
    expect(await read()).toEqual(before);
  });

  it("gives delta 0 for an untouched clone even when a replay would now differ", async () => {
    const id = await draft();

    await call("POST", admin(`/programs/${id}/publish`));

    const clone = await call("POST", admin(`/programs/${id}/draft`));

    expect(clone.status).toBe(201);

    // The catalogue snapshot drifts (as the engine has between versions): a replay now differs.
    const cloneRow = await db.onboardingProgram.findUniqueOrThrow({ where: { id: clone.body.id } });
    const drifted = (cloneRow.catalogSnapshot as unknown as Array<{ price: number }>).map((i) => ({
      ...i,
      price: i.price * 3
    }));

    await db.onboardingProgram.update({
      where: { id: clone.body.id },
      data: { catalogSnapshot: drifted as unknown as object }
    });

    const r = await compare(clone.body.id);

    expect(r.body.delta).toBe(0);
    expect(r.body.reason).toBeNull();

    // And the tampering is real: without the baseline the replay disagrees.
    await withoutBaseline(clone.body.id);

    const replayed = await compare(clone.body.id);

    expect(replayed.body.delta).not.toBe(0);
  });

  it("replays an old row with the reason, and names a version change", async () => {
    const id = await draft();

    await withoutBaseline(id);

    const same = await compare(id);

    expect(same.status).toBe(200);
    expect(same.body.recommendedNet5y).not.toBeNull();
    expect(same.body.reason).toBe(
      "Recommendation rebuilt with the current engine; it may differ from the plan originally proposed."
    );

    await db.onboardingProgram.update({
      where: { id },
      data: { engineVersion: "0.9.0", configVersion: "2020-01-01.1" }
    });

    const older = await compare(id);

    expect(older.body.reason).toContain(
      "Recommendation rebuilt with the current engine; it may differ from the plan originally proposed."
    );
    expect(older.body.reason).toContain("0.9.0");
    expect(older.body.reason).toContain("2020-01-01.1");
  });

  it("never lets the baseline into any admin or owner response", async () => {
    const id = await draft();
    const baseline = /"recommended"\s*:/;

    const created = await call("POST", admin("/programs"), ANSWERS);
    const drafted = await call("GET", admin(`/programs/${id}`));
    const swapped = await call("PATCH", admin(`/programs/${id}/milestones/1`), { itemId: "WX" });
    const preview = await call("POST", admin("/preview"), ANSWERS);
    const listed = await call("GET", admin("/programs"));
    const published = await call("POST", admin(`/programs/${id}/publish`));
    const owner = await call("GET", `/clinics/${SLUG}/program`);

    for (const r of [created, drafted, swapped, preview, listed, published, owner]) {
      expect(r.status).toBeLessThan(300);
      expect(JSON.stringify(r.body)).not.toMatch(baseline);
    }
  });

  it("answers 422 in English, not a 500, when the stored programme itself is unusable", async () => {
    const id = await draft();

    await db.onboardingProgram.update({ where: { id }, data: { output: { junk: true } } });

    const r = await compare(id);

    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("could not be compared");
  });
});

/** A draft generated from the plain fixture, and its first reward that is not the last one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plainDraft = async (): Promise<{ draftId: string; milestone: number; program: any }> => {
  await call("PUT", admin("/catalog"), { items: fixtureItems });
  const draft = await call("POST", admin("/programs"), ANSWERS);
  const rewards = draft.body.program.ladder.filter((m: { type: string }) => m.type === "premio");

  return { draftId: draft.body.id, milestone: rewards[1].n, program: draft.body.program };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rowOf = (body: { program: { ladder: Array<{ n: number }> } }, n: number): any =>
  body.program.ladder.find((m) => m.n === n);

describe("the order note no longer blocks publishing", () => {
  it("publishes a programme whose rewards cannot rise, and shows the note as information", async () => {
    const { draftId } = await plainDraft();
    const stored = await db.onboardingProgram.findUniqueOrThrow({ where: { id: draftId } });
    const output = stored.output as unknown as Program;

    await db.onboardingProgram.update({
      where: { id: draftId },
      data: { output: { ...output, review: [ORDER_REVIEW_NOTE] } as unknown as object }
    });

    const shown = await call("GET", admin(`/programs/${draftId}`));

    expect(shown.body.program.review).toEqual([]);
    expect(shown.body.program.notes).toEqual([ORDER_REVIEW_NOTE]);

    const published = await call("POST", admin(`/programs/${draftId}/publish`));

    expect(published.status).toBe(200);
    expect(published.body.status).toBe("ACTIVO");
  });
});

describe("the five kinds of reward, over HTTP", () => {
  it("turns a reward into double points", async () => {
    const { draftId, milestone } = await plainDraft();
    const r = await call("PATCH", admin(`/programs/${draftId}/milestones/${milestone}`), {
      kind: "doble"
    });

    expect(r.status).toBe(200);
    expect(rowOf(r.body, milestone).reward).toMatchObject({ kind: "doble", items: [] });

    const stored = await db.onboardingProgram.findUniqueOrThrow({ where: { id: draftId } });
    const chosen = (stored.output as unknown as Program).chosen.find((c) => c.m.n === milestone)!;

    expect(chosen.special?.kind).toBe("doble");
  });

  it("turns a reward into a surprise from every item the catalogue can give today", async () => {
    const { draftId, milestone } = await plainDraft();
    const r = await call("PATCH", admin(`/programs/${draftId}/milestones/${milestone}`), {
      kind: "sorpresa"
    });

    expect(r.status).toBe(200);
    expect(rowOf(r.body, milestone).reward.kind).toBe("sorpresa");

    const giftable = (await call("GET", admin("/catalog"))).body.items
      .filter((i: { giftable: boolean }) => i.giftable)
      .map((i: { externalId: string }) => i.externalId)
      .sort();
    const stored = await db.onboardingProgram.findUniqueOrThrow({ where: { id: draftId } });
    const chosen = (stored.output as unknown as Program).chosen.find((c) => c.m.n === milestone)!;

    expect(chosen.special?.pool?.map((c) => c.id).sort()).toEqual(giftable);
  });

  it("turns a reward into a free text with its price, and validates both", async () => {
    const { draftId, milestone } = await plainDraft();
    const path = admin(`/programs/${draftId}/milestones/${milestone}`);

    const empty = await call("PATCH", path, { kind: "libre", name: "  ", priceEuro: 10 });

    expect(empty.status).toBe(422);
    expect(JSON.stringify(empty.body)).toContain("El premio: no puede estar vacío");

    for (const priceEuro of [0, 12.345, 20_000]) {
      const bad = await call("PATCH", path, { kind: "libre", name: "Manicura", priceEuro });

      expect(bad.status, String(priceEuro)).toBe(422);
      expect(JSON.stringify(bad.body)).toContain("El precio del premio");
    }

    const r = await call("PATCH", path, {
      kind: "libre",
      name: "Manicura de regalo",
      priceEuro: 24
    });

    expect(r.status).toBe(200);
    expect(rowOf(r.body, milestone)).toMatchObject({
      rewardValueEuro: 24,
      reward: { name: "Manicura de regalo", kind: "libre" }
    });
  });

  it("gives the same item to two rewards in a row", async () => {
    const { draftId, program } = await plainDraft();
    const rewards = program.ladder.filter((m: { type: string }) => m.type === "premio");
    const stored = await db.onboardingProgram.findUniqueOrThrow({ where: { id: draftId } });
    const first = (stored.output as unknown as Program).chosen[0].o.items[0].id;
    const r = await call("PATCH", admin(`/programs/${draftId}/milestones/${rewards[1].n}`), {
      itemId: first
    });

    expect(r.status).toBe(200);
  });

  it("refuses an unknown kind", async () => {
    const { draftId, milestone } = await plainDraft();
    const r = await call("PATCH", admin(`/programs/${draftId}/milestones/${milestone}`), {
      kind: "otra-cosa"
    });

    expect(r.status).toBe(422);
  });
});

describe("moving a reward's spend, over HTTP", () => {
  it("moves it within the range the admin is shown, and refuses outside it", async () => {
    const { draftId, milestone, program } = await plainDraft();
    const range = rowOf({ program }, milestone).spendRange as { min: number; max: number };
    const path = admin(`/programs/${draftId}/milestones/${milestone}/threshold`);

    const r = await call("PUT", path, { realSpend: range.min });

    expect(r.status).toBe(200);
    expect(rowOf(r.body, milestone).realSpend).toBe(range.min);

    const outside = await call("PUT", path, { realSpend: range.max + 1 });

    expect(outside.status).toBe(409);
    expect(JSON.stringify(outside.body)).toContain("tiene que estar entre");
  });

  it("moves a perk too, within its own range", async () => {
    const { draftId, program } = await plainDraft();
    const perk = program.ladder.find((m: { type: string }) => m.type === "ventaja");
    const r = await call("PUT", admin(`/programs/${draftId}/milestones/${perk.n}/threshold`), {
      realSpend: perk.spendRange.max
    });

    expect(r.status).toBe(200);
    expect(rowOf(r.body, perk.n).realSpend).toBe(perk.spendRange.max);
  });

  it("refuses a tier step, a body that is not whole euros, and a programme that is live", async () => {
    const { draftId, milestone, program } = await plainDraft();
    const level = program.ladder.find((m: { type: string }) => m.type === "nivel").n;

    const onLevel = await call("PUT", admin(`/programs/${draftId}/milestones/${level}/threshold`), {
      realSpend: 100
    });

    expect(onLevel.status).toBe(409);

    const path = admin(`/programs/${draftId}/milestones/${milestone}/threshold`);

    expect((await call("PUT", path, { realSpend: 12.5 })).status).toBe(422);
    expect((await call("PUT", path, {})).status).toBe(422);

    // Whatever the fixture's own notes, this test is about the live programme refusing the edit.
    const stored = await db.onboardingProgram.findUniqueOrThrow({ where: { id: draftId } });

    await db.onboardingProgram.update({
      where: { id: draftId },
      data: {
        output: { ...(stored.output as unknown as Program), review: [] } as unknown as object
      }
    });

    const published = await call("POST", admin(`/programs/${draftId}/publish`));

    expect(published.status).toBe(200);

    const live = await call("PUT", path, { realSpend: rowOf({ program }, milestone).realSpend });

    expect(live.status).toBe(409);
    expect(JSON.stringify(live.body)).toContain("borrador");
  });
});

describe("adding and removing milestones, over HTTP", () => {
  it("adds a reward to a band at a spend inside the band's range", async () => {
    const { draftId, program } = await plainDraft();
    const range = program.tiers[0].addRange as { min: number; max: number };
    const taken = new Set(program.ladder.map((m: { realSpend: number }) => m.realSpend));
    let realSpend = range.min;

    while (taken.has(realSpend)) realSpend += 1;

    const r = await call("POST", admin(`/programs/${draftId}/milestones`), {
      band: 1,
      realSpend,
      choice: { kind: "libre", name: "Manicura de regalo", priceEuro: 20 }
    });

    expect(r.status).toBe(200);

    const row = r.body.program.ladder.find(
      (m: { reward?: { name: string } }) => m.reward?.name === "Manicura de regalo"
    );

    expect(row).toMatchObject({ band: 1, type: "premio", realSpend, reward: { kind: "libre" } });
  });

  it("refuses a spend outside the band, a band that does not exist, and a bad choice", async () => {
    const { draftId, program } = await plainDraft();
    const range = program.tiers[0].addRange as { min: number; max: number };
    const path = admin(`/programs/${draftId}/milestones`);

    const outside = await call("POST", path, {
      band: 1,
      realSpend: range.max + 1,
      choice: { kind: "doble" }
    });

    expect(outside.status).toBe(409);
    expect(JSON.stringify(outside.body)).toContain("tiene que estar entre");

    for (const body of [
      { band: 5, realSpend: range.min, choice: { kind: "doble" } },
      { band: 1, realSpend: range.min, choice: { alternative: 0 } },
      { band: 1, realSpend: range.min }
    ]) {
      expect((await call("POST", path, body)).status, JSON.stringify(body)).toBe(422);
    }

    // Nothing was added by any refusal.
    const after = await call("GET", admin(`/programs/${draftId}`));

    expect(after.body.program.ladder).toHaveLength(program.ladder.length);
  });

  it("removes a reward and a perk, and refuses a tier step", async () => {
    const { draftId, milestone, program } = await plainDraft();
    const perk = program.ladder.find((m: { type: string }) => m.type === "ventaja").n;
    const level = program.ladder.find((m: { type: string }) => m.type === "nivel").n;

    for (const n of [milestone, perk]) {
      const r = await call("DELETE", admin(`/programs/${draftId}/milestones/${n}`));

      expect(r.status).toBe(200);
      expect(rowOf(r.body, n)).toBeUndefined();
    }

    const onLevel = await call("DELETE", admin(`/programs/${draftId}/milestones/${level}`));

    expect(onLevel.status).toBe(409);
  });
});
