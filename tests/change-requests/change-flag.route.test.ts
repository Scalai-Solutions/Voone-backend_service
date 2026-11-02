import { describe, expect, it, beforeEach, afterAll } from "vitest";

import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";
import { CONFIG_VERSION, ENGINE_VERSION } from "../../src/modules/onboarding/engine.config";
import { run } from "../../src/modules/onboarding/engine";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import catalog from "../onboarding/reference/sapphira.catalogo.json";
import { ADMIN, MANAGER, OWNER, useRouteHarness } from "./harness";

/**
 * The what-if flag over HTTP, against a real database: the owner's blurred preview and the
 * admin's exact comparison, on a real Sapphira programme. Milestone 14 holds F3 (Tratamiento
 * Mirada), so a price edit of F3 is a price edit of a live reward; L2 is a dearer giftable item.
 */
const h = useRouteHarness("test-cr-flagroute");
const { db, call, make } = h;

const SLUG_C = "test-cr-flagroute-c";
const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const repo = new PrismaCatalogRepository(db);
const items = (catalog as CatalogItem[]).map((i) => ({
  externalId: i.id,
  name: i.name,
  priceEuro: i.price,
  isProduct: i.product ?? false,
  costPctOverride: i.costPct ?? null,
  estimated: i.estimated ?? false
}));

const program = (): Program => {
  const result = run(catalog as CatalogItem[], ANSWERS);

  if (isEngineError(result)) throw new Error(result.error);

  return result;
};

const publish = (clinicId: string, status: "ACTIVO" | "BORRADOR" = "ACTIVO") => {
  const output = program();

  return db.onboardingProgram.create({
    data: {
      clinicId,
      version: 1,
      status,
      engineVersion: ENGINE_VERSION,
      configVersion: CONFIG_VERSION,
      answers: ANSWERS as object,
      catalogSnapshot: catalog as object,
      output: { ...output, recommended: structuredClone(output) } as object
    }
  });
};

/** Ids of every catalogue row that the live programme gives as a reward. */
const rewardIds = (): Set<string> => {
  const out = program();
  const ids = new Set<string>();

  for (const c of out.chosen) for (const it of c.o.items) ids.add(it.id);
  for (const it of out.rec.o.items) ids.add(it.id);

  return ids;
};

const treatmentIdOf = async (clinicId: string, externalId: string): Promise<string> => {
  const row = await db.catalogItem.findFirstOrThrow({ where: { clinicId, externalId } });

  return row.id;
};

const preview = (slug: string, who: object | undefined, body: unknown) =>
  call("POST", `/clinics/${slug}/change-requests/preview`, who as never, body);

const rewardBody = (proposed: Record<string, unknown>) => ({
  type: "REWARD",
  targetRef: { milestone: 14 },
  proposed
});

const wipeCatalogues = async () => {
  await db.onboardingProgram.deleteMany({ where: { clinicId: { in: [h.a.id, h.b.id] } } });
  await db.catalogItem.deleteMany({ where: { clinicId: { in: [h.a.id, h.b.id] } } });
};

beforeEach(async () => {
  await wipeCatalogues();
  await repo.replaceForClinic(h.a.id, items);
  // The other clinic has an item clinic A does not, and a draft only (nothing live).
  await repo.replaceForClinic(h.b.id, [
    ...items,
    { externalId: "B-ONLY", name: "Servicio solo de B", priceEuro: 80, categoryId: "FAC" }
  ]);
  await publish(h.a.id);
  await publish(h.b.id, "BORRADOR");
});

afterAll(async () => {
  await wipeCatalogues();
  await db.clinic.deleteMany({ where: { slug: SLUG_C } });
});

const OWNER_FORBIDDEN_KEYS = [
  "years",
  "live",
  "proposed",
  "recommended",
  "rewardValueEuro",
  "reason",
  "itemName"
];

const keysDeep = (value: unknown, into = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, into));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysDeep(v, into);
    }
  }

  return into;
};

describe("POST /clinics/:slug/change-requests/preview (the owner)", () => {
  /** The admin's exact answer for the same inputs; none of its numbers may be in the owner's JSON. */
  const expectNoExactFigures = async (
    owner: Awaited<ReturnType<typeof preview>>,
    ticketBody: Record<string, unknown>
  ) => {
    expect(owner.status).toBe(200);
    expect(owner.body.status).toBe("ok");
    expect(owner.body.vsCurrent).toHaveLength(5);
    expect(["good", "costs-more", "similar"]).toContain(owner.body.signal);

    const keys = keysDeep(owner.body);

    for (const forbidden of OWNER_FORBIDDEN_KEYS) expect(keys.has(forbidden)).toBe(false);

    const ticket = await make(h.slugA, OWNER, ticketBody);
    const admin = await call("GET", `/admin/change-requests/${ticket.id}/comparison`, ADMIN);

    expect(admin.status).toBe(200);
    expect(admin.body.status).toBe("ok");

    const exact = new Set<number>();

    for (const y of admin.body.years) {
      for (const n of [y.live, y.proposed, y.recommended, y.vsLive.euros, y.vsRecommended?.euros]) {
        if (typeof n === "number") exact.add(Math.abs(n));
      }
    }

    exact.add(admin.body.inputs.clients);
    exact.add(admin.body.inputs.ticket);

    const tokens = new Set((JSON.stringify(owner.body).match(/\d+(\.\d+)?/g) ?? []).map(Number));

    // Only numbers large enough to be a real figure; 0, 5, 100 and so on are not exact data.
    for (const n of exact) if (n >= 1000) expect(tokens.has(n)).toBe(false);

    // Every euro the owner sees is a multiple of 100 and every percent a multiple of 5.
    for (const cell of [...owner.body.vsCurrent, ...(owner.body.vsRecommended ?? [])]) {
      if (cell.euros !== null) expect(Math.abs(cell.euros) % 100).toBe(0);
      if (cell.percent !== null) expect(Math.abs(cell.percent) % 5).toBe(0);
    }

    return admin.body;
  };

  it("(a) a giftable item on a premio milestone: ok, five blurred cells, nothing exact", async () => {
    const body = { milestone: 14, itemId: "L2" };
    const res = await preview(h.slugA, OWNER, rewardBody(body));

    await expectNoExactFigures(res, {
      type: "REWARD",
      targetRef: { milestone: 14 },
      proposed: body
    });
  });

  it("(a) the same with real money in it: a big price edit shows blurred euros, never the exact ones", async () => {
    const treatmentId = await treatmentIdOf(h.a.id, "F3");
    const edit = { type: "SERVICE_EDIT", targetRef: { treatmentId }, proposed: { priceEuro: 400 } };
    const res = await preview(h.slugA, OWNER, edit);
    const admin = await expectNoExactFigures(res, edit);

    // Not vacuous: the owner's year 5 has a real, blurred amount, and the admin's is exact.
    expect(res.body.signal).toBe("costs-more");
    expect(res.body.vsCurrent[4].euros).toBeLessThan(0);
    expect(Math.abs(res.body.vsCurrent[4].euros) % 100).toBe(0);
    expect(res.body.fiveYearEuros).toBe(res.body.vsCurrent[4].euros);
    expect(Math.abs(admin.years[4].vsLive.euros - res.body.fiveYearEuros)).toBeLessThanOrEqual(50);
    expect(Math.abs(admin.years[4].vsLive.euros) % 100).not.toBe(0);
  });

  it("a manager gets the same preview as an owner", async () => {
    const res = await preview(h.slugA, MANAGER, rewardBody({ milestone: 14, itemId: "W8" }));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("a price edit of a live reward service is ok, with the same blurred shape", async () => {
    const treatmentId = await treatmentIdOf(h.a.id, "F3");
    const res = await preview(h.slugA, OWNER, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId },
      proposed: { priceEuro: 150 }
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.vsCurrent).toHaveLength(5);
    expect(keysDeep(res.body).has("priceEuro")).toBe(false);
  });

  it("(b) text only is exactly unpriced", async () => {
    const res = await preview(h.slugA, OWNER, rewardBody({ text: "Un masaje relajante" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "unpriced" });
  });

  it("(c) a clinic with no ACTIVE programme (only a draft) gets exactly none", async () => {
    const res = await preview(h.slugB, OWNER, rewardBody({ milestone: 14, itemId: "L2" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "none" });
  });

  it("(d) another clinic's item or treatment is exactly none, never an ok", async () => {
    const foreignItem = await preview(
      h.slugA,
      OWNER,
      rewardBody({ milestone: 14, itemId: "B-ONLY" })
    );
    const foreignTreatment = await preview(h.slugA, OWNER, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: await treatmentIdOf(h.b.id, "F3") },
      proposed: { priceEuro: 150 }
    });

    expect(foreignItem.body).toEqual({ status: "none" });
    expect(foreignTreatment.body).toEqual({ status: "none" });
  });

  it("a non-reward service, an unknown treatment, a name-only edit and a medical item are none", async () => {
    const used = rewardIds();
    const plain = items.find((i) => !used.has(i.externalId) && !i.isProduct)!;
    const edit = async (treatmentId: string, proposed: Record<string, unknown>) =>
      (
        await preview(h.slugA, OWNER, {
          type: "SERVICE_EDIT",
          targetRef: { treatmentId },
          proposed
        })
      ).body;

    expect(await edit(await treatmentIdOf(h.a.id, plain.externalId), { priceEuro: 99 })).toEqual({
      status: "none"
    });
    expect(await edit("no-such-treatment", { priceEuro: 99 })).toEqual({ status: "none" });
    expect(await edit(await treatmentIdOf(h.a.id, "F3"), { name: "Otro nombre" })).toEqual({
      status: "none"
    });
    expect(
      (await preview(h.slugA, OWNER, rewardBody({ milestone: 14, itemId: "M1" }))).body
    ).toEqual({ status: "none" });
  });

  it("(e) refuses VOONE_ADMIN, a missing role and an unknown role with 403", async () => {
    const body = rewardBody({ milestone: 14, itemId: "L2" });

    for (const who of [ADMIN, {}, { actor: "x@a.test" }, { role: "viewer" }]) {
      const res = await preview(h.slugA, who, body);

      expect(res.status).toBe(403);
    }
  });

  it("(e) an unknown body key is a 422 in Spanish, and so is a type with no flag", async () => {
    const withKey = await preview(h.slugA, OWNER, {
      ...rewardBody({ milestone: 14, itemId: "L2" }),
      clinicId: h.b.id
    });
    const withProposedKey = await preview(h.slugA, OWNER, {
      type: "REWARD",
      proposed: { itemId: "L2", cost: 1 }
    });
    const level = await preview(h.slugA, OWNER, { type: "LEVEL", targetRef: { tier: "Oro" } });
    const empty = await preview(h.slugA, OWNER, undefined);

    for (const res of [withKey, withProposedKey, level, empty]) {
      expect(res.status).toBe(422);
      expect(res.body.code).toBeDefined();
      expect(res.body.message).toMatch(/[áéíóúñ.]/);
    }
  });

  it("takes the clinic from the path slug: an unknown slug is a 404", async () => {
    const res = await preview("no-such-clinic-slug", OWNER, rewardBody({ itemId: "L2" }));

    expect(res.status).toBe(404);
  });

  it("(f) the 31st call within a minute for one slug is a 429; another slug is unaffected", async () => {
    await db.clinic.upsert({
      where: { slug: SLUG_C },
      update: {},
      create: {
        slug: SLUG_C,
        name: "Clinica Limite",
        addressLine: "Calle Prueba 3",
        pincode: "28001"
      }
    });

    const body = rewardBody({ text: "Un masaje" });

    for (let i = 1; i <= 30; i++) {
      const res = await preview(SLUG_C, OWNER, body);

      expect(res.status).toBe(200);
    }

    const limited = await preview(SLUG_C, OWNER, body);

    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");

    // The limit is per slug, and a refused role never counts against it.
    expect((await preview(h.slugA, OWNER, body)).status).toBe(200);
    expect((await preview(SLUG_C, ADMIN, body)).status).toBe(403);
  });
});

describe("GET /admin/change-requests/:id/comparison (Voone)", () => {
  const comparison = (id: string, who: object | undefined = ADMIN) =>
    call("GET", `/admin/change-requests/${id}/comparison`, who as never);

  it("(g) a REWARD ticket: exact years with vsLive and vsRecommended, and the item's name", async () => {
    const ticket = await make(h.slugA, OWNER, {
      type: "REWARD",
      targetRef: { milestone: 14 },
      proposed: { milestone: 14, itemId: "L2" }
    });
    const res = await comparison(ticket.id);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.itemName).toBe("Láser cuerpo completo");
    expect(res.body.years).toHaveLength(5);

    for (const y of res.body.years) {
      expect(Number.isInteger(y.live)).toBe(true);
      expect(Number.isInteger(y.proposed)).toBe(true);
      expect(y.vsLive.euros).toBe(y.proposed - y.live);
      expect(y.vsRecommended.euros).toBe(y.proposed - y.recommended);
    }

    expect(res.body.inputs.clients).toBeGreaterThan(0);
    // A dearer reward costs more over five years than the live plan.
    expect(res.body.years[4].vsLive.euros).toBeLessThan(0);
  });

  it("a REWARD ticket with text only is unpriced, with no item name", async () => {
    const ticket = await make(h.slugA, OWNER, {
      type: "REWARD",
      targetRef: { milestone: 14 },
      proposed: { text: "Un masaje" }
    });
    const res = await comparison(ticket.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "unpriced", itemName: null });
  });

  it("a REWARD ticket with an item the clinic does not have is none with an English reason", async () => {
    const ticket = await make(h.slugA, OWNER, {
      type: "REWARD",
      targetRef: { milestone: 14 },
      proposed: { milestone: 14, itemId: "B-ONLY" }
    });
    const res = await comparison(ticket.id);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("none");
    expect(res.body.reason).toMatch(/catalogue/i);
  });

  it("(g) a SERVICE_EDIT ticket on a live reward is ok, on a non-reward it is none", async () => {
    const used = rewardIds();
    const plain = items.find((i) => !used.has(i.externalId) && !i.isProduct)!;
    const onReward = await make(h.slugA, OWNER, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: await treatmentIdOf(h.a.id, "F3") },
      proposed: { priceEuro: 150 }
    });
    const onPlain = await make(h.slugA, OWNER, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: await treatmentIdOf(h.a.id, plain.externalId) },
      proposed: { priceEuro: 150 }
    });

    expect((await comparison(onReward.id)).body.status).toBe("ok");

    const none = (await comparison(onPlain.id)).body;

    expect(none.status).toBe("none");
    expect(none.reason).toMatch(/not a live reward/i);
  });

  it("a ticket type with no flag is none", async () => {
    const ticket = await make(h.slugA, OWNER, { type: "OTHER" });
    const res = await comparison(ticket.id);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("none");
    expect(typeof res.body.reason).toBe("string");
  });

  it("(g) refuses a non-admin role with 403 and a missing ticket with 404", async () => {
    const ticket = await make(h.slugA, OWNER, { type: "REWARD", proposed: { text: "x y" } });

    for (const who of [OWNER, MANAGER, {}, { role: "viewer" }]) {
      expect((await comparison(ticket.id, who)).status).toBe(403);
    }

    const missing = await comparison("00000000-0000-4000-8000-000000000000");

    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe("Request not found.");
  });
});
