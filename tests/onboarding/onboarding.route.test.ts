import { PointsTransactionKind, PrismaClient, type Clinic } from "@prisma/client";
import express, { type Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { errorHandler } from "../../src/common/middleware/error-handler";
import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";
import type { CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { OnboardingService } from "../../src/modules/onboarding/onboarding.service";
import { presentProgram } from "../../src/modules/onboarding/presentation";
import { programView } from "../../src/modules/onboarding/runtime/program-view";
import { PrismaProgramTierPort } from "../../src/modules/onboarding/runtime/program-tier.port";
import { RewardService } from "../../src/modules/onboarding/runtime/reward.service";
import { VisitService } from "../../src/modules/onboarding/runtime/visit.service";
import {
  PrismaMemberPointsCache,
  PrismaPointsLedgerRepository
} from "../../src/modules/points/prisma-points-ledger.repository";
import { PointsService } from "../../src/modules/points/points.service";
import { ClinicNotFoundError } from "../../src/common/errors/membership.errors";
import { createOnboardingRouter } from "../../src/routes/v1/onboarding.route";
import { createPointsRouter } from "../../src/routes/v1/points.route";
import catalogFixture from "./reference/sapphira.catalogo.json";

/**
 * The onboarding API, over HTTP, against a real database.
 *
 * Service tests cannot catch the class of bug that matters most at this layer: whether a
 * refusal reaches the person who needs it as the sentence they need. The error handler
 * answers 500 "Internal server error" to anything it does not recognise, so a service that
 * throws the wrong kind of error passes every service test and fails every real request.
 * Every assertion about an error here is therefore on the status AND the Spanish message.
 */
const db = new PrismaClient();

const SLUG = "test-route";
const ANSWERS = {
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const catalog = new PrismaCatalogRepository(db);
const onboarding = new OnboardingService(db, catalog);
const points = new PointsService(
  new PrismaPointsLedgerRepository(db),
  new PrismaMemberPointsCache(db),
  { enqueueMemberSync: async () => {}, close: async () => {} },
  undefined,
  new PrismaProgramTierPort(db)
);

const app = ((): Express => {
  const a = express();

  a.use(express.json());
  a.use(
    "/api/v1",
    createOnboardingRouter({
      onboarding,
      catalog,
      visits: new VisitService(db, points),
      rewards: new RewardService(db),
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
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
};

let clinic: Clinic;
let phoneSeq = 0;

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
  await db.memberReward.deleteMany({ where: { clinicId: clinic.id } });
  await db.referral.deleteMany({ where: { clinicId: clinic.id } });
  await db.paidVisit.deleteMany({ where: { clinicId: clinic.id } });
  await db.pointsTransaction.deleteMany({ where: { clinicId: clinic.id } });
  await db.member.deleteMany({ where: { clinicId: clinic.id } });
  await db.onboardingProgram.deleteMany({ where: { clinicId: clinic.id } });
  await db.catalogItem.deleteMany({ where: { clinicId: clinic.id } });
};

/** Catalogue loaded, draft generated and published, through the API. */
const goLive = async (): Promise<string> => {
  await call("PUT", admin("/catalog"), { items: fixtureItems });
  const draft = await call("POST", admin("/programs"), ANSWERS);
  const live = await call("POST", admin(`/programs/${draft.body.id}/publish`));

  expect(live.status).toBe(200);

  return draft.body.id as string;
};

const newMember = async () => {
  phoneSeq += 1;

  return db.member.create({
    data: {
      clinicId: clinic.id,
      name: `Clienta ${phoneSeq}`,
      phone: `+34688000${String(phoneSeq).padStart(3, "0")}`,
      code: `R${String(phoneSeq).padStart(3, "0")}X`,
      consentMarketing: false,
      consentSource: "staff_entry"
    }
  });
};

beforeAll(async () => {
  clinic = await db.clinic.upsert({
    where: { slug: SLUG },
    update: {},
    create: { slug: SLUG, name: "Centro de ruta", addressLine: "Calle Tres 3", pincode: "28003" }
  });
  await wipe();
});

beforeEach(async () => {
  await wipe();
  phoneSeq = 0;
});

afterAll(async () => {
  await wipe();
  await db.clinic.deleteMany({ where: { slug: SLUG } });
  await db.$disconnect();
});

describe("the catalogue", () => {
  it("answers 404 for a clinic that does not exist, on every admin route", async () => {
    const ghost = "/admin/clinics/does-not-exist/onboarding";

    for (const [method, path, body] of [
      ["GET", "/catalog", undefined],
      ["PUT", "/catalog", { items: [] }],
      ["GET", "/estimates", undefined],
      ["GET", "/programs", undefined],
      ["POST", "/programs", ANSWERS],
      ["GET", "/recalibration", undefined]
    ] as const) {
      const r = await call(method, `${ghost}${path}`, body);

      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });

  it("stores a catalogue and shows each row's category and where it came from", async () => {
    const r = await call("PUT", admin("/catalog"), { items: fixtureItems });

    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(fixtureItems.length);

    const hydra = r.body.items.find((i: { externalId: string }) => i.externalId === "F2");

    expect(hydra).toMatchObject({ category: "APF", classifiedBy: "palabra clave", priceEuro: 75 });
    // Retail is filed by its flag, not by a keyword.
    expect(r.body.items.find((i: { externalId: string }) => i.externalId === "K1")).toMatchObject({
      category: "COS",
      classifiedBy: "producto"
    });
  });

  it("accepts an empty catalogue and answers with an empty list", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const r = await call("PUT", admin("/catalog"), { items: [] });

    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });

  it("hides the database id, which is not the identity the engine uses", async () => {
    const r = await call("PUT", admin("/catalog"), { items: fixtureItems });

    expect(Object.keys(r.body.items[0])).not.toContain("id");
  });

  it("refuses bad input with the Spanish sentence for the field", async () => {
    const negative = await call("PUT", admin("/catalog"), {
      items: [{ name: "Facial", priceEuro: -5 }]
    });
    const category = await call("PUT", admin("/catalog"), {
      items: [{ name: "Facial", priceEuro: 5, categoryId: "NOPE" }]
    });
    const duplicate = await call("PUT", admin("/catalog"), {
      items: [
        { externalId: "A", name: "Uno", priceEuro: 1 },
        { externalId: "A", name: "Dos", priceEuro: 2 }
      ]
    });

    expect(negative.status).toBe(422);
    expect(negative.body.message).toContain("no puede ser negativo");
    expect(category.status).toBe(422);
    expect(category.body.message).toContain("Categoría desconocida");
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.message).toContain("repetido");
  });

  it("lets the centre classify a row the engine could not", async () => {
    await call("PUT", admin("/catalog"), {
      items: [{ externalId: "X1", name: "Servicio sin nombre reconocible", priceEuro: 40 }]
    });

    const before = await call("GET", admin("/catalog"));

    expect(before.body.items[0]).toMatchObject({
      needsReview: true,
      classifiedBy: "sin clasificar"
    });

    const after = await call("PATCH", admin("/catalog/X1"), { categoryId: "FAC" });

    expect(after.status).toBe(200);
    expect(after.body.items[0]).toMatchObject({
      category: "FAC",
      classifiedBy: "centro",
      needsReview: false
    });
  });

  it("answers 404 for a row that does not exist and 422 for an empty patch", async () => {
    await call("PUT", admin("/catalog"), {
      items: [{ externalId: "A", name: "Uno", priceEuro: 1 }]
    });

    const missing = await call("PATCH", admin("/catalog/NOPE"), { priceEuro: 10 });
    const empty = await call("PATCH", admin("/catalog/A"), {});

    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe("No existe esa fila del catálogo.");
    expect(empty.status).toBe(422);
  });

  it("imports a CSV, reporting the rows it could not read", async () => {
    const r = await call("POST", admin("/catalog/import"), {
      csv: "Nombre;Precio\nHigiene facial;60\nMasaje relajante;45,50\nrota\nCrema;40;producto"
    });

    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(3);
    expect(r.body.skipped).toEqual([
      expect.objectContaining({ line: 4, reason: expect.stringContaining("columnas") })
    ]);
    expect(r.body.items.map((i: { name: string }) => i.name)).toEqual([
      "Higiene facial",
      "Masaje relajante",
      "Crema"
    ]);
    expect(r.body.items[1].priceEuro).toBe(45.5);
  });

  it("explains an import that read nothing", async () => {
    const r = await call("POST", admin("/catalog/import"), { csv: "esto no es un catálogo" });

    expect(r.status).toBe(422);
    expect(r.body.message).toContain("punto y coma");
  });
});

describe("generating a programme", () => {
  it("cannot estimate without a catalogue, and says what to do", async () => {
    const r = await call("GET", admin("/estimates"));

    expect(r.status).toBe(400);
    expect(r.body.message).toContain("catálogo");
  });

  it("offers the pre-selected buckets the questions screen needs", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const r = await call("GET", admin("/estimates"));

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      segment: "high",
      ticketEstimate: 65,
      preselectedTicketBucket: "t2",
      preselectedFreqBucket: "f4"
    });
  });

  it("creates a draft and returns the programme with the internal block", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const r = await call("POST", admin("/programs"), ANSWERS);

    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ version: 1, status: "BORRADOR" });
    expect(r.body.program.ladder.length).toBeGreaterThan(10);
    expect(r.body.internal.costPct).toBeGreaterThan(0);
    expect(r.body.internal.guarantees.length).toBeGreaterThan(5);
  });

  it("returns the answers it was generated from, so the screens can pre-fill", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), {
      ...ANSWERS,
      investment: "generoso",
      occupancy: "o3"
    });

    expect(draft.body.answers).toMatchObject({ investment: "generoso", occupancy: "o3" });
    expect((await call("GET", admin(`/programs/${draft.body.id}`))).body.answers).toMatchObject({
      investment: "generoso"
    });
  });

  it("NEVER puts a cost in the programme a centre sees", async () => {
    // The guide is explicit: "No costs and no revenue figures anywhere." The presentation is
    // built from a projection that never reads a cost, so this fails the day someone adds one.
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);
    const text = JSON.stringify(draft.body.program);

    expect(text).not.toMatch(/"cost/i);
    expect(text).not.toMatch(/"budget/i);
    expect(text).not.toMatch(/"cb"|"cap"/);
    // ...and the same for the live view a centre's own staff get.
    await call("POST", admin(`/programs/${draft.body.id}/publish`));
    const live = await call("GET", `/clinics/${SLUG}/program`);

    expect(JSON.stringify(live.body)).not.toMatch(/"cost|"budget|costPct|guarantees/i);
  });

  it("rejects incomplete answers with the question the centre skipped", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const r = await call("POST", admin("/programs"), { objective: "equilibrado" });

    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/inversi|devolver|ocupaci/);
  });

  it("passes the engine's own refusal to the centre", async () => {
    await call("PUT", admin("/catalog"), {
      items: [{ externalId: "M1", name: "Toxina botulínica", priceEuro: 300 }]
    });
    const r = await call("POST", admin("/programs"), ANSWERS);

    expect(r.status).toBe(400);
    expect(r.body.message).toContain("tratamientos con precio");
  });

  it("lists versions and fetches one, scoped to the clinic", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const a = await call("POST", admin("/programs"), ANSWERS);
    await call("POST", admin("/programs"), { ...ANSWERS, investment: "generoso" });

    const list = await call("GET", admin("/programs"));

    expect(list.body.programs.map((p: { version: number }) => p.version)).toEqual([2, 1]);
    expect((await call("GET", admin(`/programs/${a.body.id}`))).status).toBe(200);

    const missing = await call("GET", admin("/programs/not-a-real-id"));

    expect(missing.status).toBe(404);
    expect(missing.body.message).toContain("No existe ese programa");
  });
});

describe("the live preview", () => {
  it("returns a programme and stores nothing", async () => {
    // The reason it exists: a centre trying four investment levels must not leave four
    // numbered drafts behind.
    await call("PUT", admin("/catalog"), { items: fixtureItems });

    for (const investment of ["conservador", "equilibrado", "generoso"]) {
      const r = await call("POST", admin("/preview"), { ...ANSWERS, investment });

      expect(r.status).toBe(200);
      expect(r.body.program.ladder.length).toBeGreaterThan(10);
    }

    expect(await db.onboardingProgram.count({ where: { clinicId: clinic.id } })).toBe(0);
  });

  it("shows exactly what saving would store", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });

    const preview = await call("POST", admin("/preview"), ANSWERS);
    const saved = await call("POST", admin("/programs"), ANSWERS);

    expect(preview.body.program).toEqual(saved.body.program);
  });

  it("carries the same internal block and no cost in the centre-facing part", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const r = await call("POST", admin("/preview"), ANSWERS);

    expect(r.body.internal.costPct).toBeGreaterThan(0);
    expect(JSON.stringify(r.body.program)).not.toMatch(/"cost|"budget/i);
  });

  it("is not read as a programme id", async () => {
    // "preview" sits beside /programs/:programId, and a route order mistake would answer
    // "no existe ese programa" instead.
    await call("PUT", admin("/catalog"), { items: fixtureItems });

    expect((await call("POST", admin("/preview"), ANSWERS)).status).toBe(200);
  });

  it("refuses in Spanish without a catalogue, with bad answers, and for an unknown clinic", async () => {
    const empty = await call("POST", admin("/preview"), ANSWERS);

    expect(empty.status).toBe(400);
    expect(empty.body.message).toContain("catálogo");

    await call("PUT", admin("/catalog"), { items: fixtureItems });

    expect((await call("POST", admin("/preview"), { objective: "equilibrado" })).status).toBe(422);
    expect(
      (await call("POST", "/admin/clinics/does-not-exist/onboarding/preview", ANSWERS)).status
    ).toBe(404);
  });
});

describe("publishing and editing", () => {
  it("publishes a clean draft", async () => {
    const id = await goLive();
    const r = await call("GET", admin(`/programs/${id}`));

    expect(r.body.status).toBe("ACTIVO");
    expect(r.body.publishedAt).not.toBeNull();
  });

  it("refuses to publish while the programme has review notes, and says why", async () => {
    await call("PUT", admin("/catalog"), {
      items: [
        ...fixtureItems,
        { externalId: "X9", name: "Servicio sin nombre reconocible", priceEuro: 40 }
      ]
    });
    const draft = await call("POST", admin("/programs"), ANSWERS);
    const r = await call("POST", admin(`/programs/${draft.body.id}/publish`));

    expect(r.status).toBe(409);
    expect(r.body.message).toContain("avisos que resolver");
    expect(r.body.message).toContain("sin categoría");
  });

  it("swaps a reward for one of its alternatives", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);
    const before = draft.body.program.ladder.find((m: { n: number }) => m.n === 7);

    expect(before.reward.alternatives.length).toBeGreaterThan(0);

    const r = await call("PATCH", admin(`/programs/${draft.body.id}/milestones/7`), {
      alternative: 0
    });

    expect(r.status).toBe(200);
    expect(r.body.program.ladder.find((m: { n: number }) => m.n === 7).reward.name).toBe(
      before.reward.alternatives[0].name
    );
  });

  it("refuses a swap that does not exist, in Spanish", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);

    const none = await call("PATCH", admin(`/programs/${draft.body.id}/milestones/9`), {
      alternative: 0
    });
    const notAReward = await call("PATCH", admin(`/programs/${draft.body.id}/milestones/2`), {
      alternative: 0
    });

    expect(none.status).toBe(409);
    expect(none.body.message).toBe("Esa alternativa no existe.");
    expect(notAReward.status).toBe(409);
    expect(notAReward.body.message).toContain("no tiene un premio");
  });

  it("validates the swap request itself", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);

    expect(
      (await call("PATCH", admin(`/programs/${draft.body.id}/milestones/7`), { alternative: 7 }))
        .status
    ).toBe(422);
    expect(
      (await call("PATCH", admin(`/programs/${draft.body.id}/milestones/abc`), { alternative: 0 }))
        .status
    ).toBe(422);
  });

  it("will not edit a programme that is already live", async () => {
    const id = await goLive();
    const r = await call("PATCH", admin(`/programs/${id}/milestones/7`), { alternative: 0 });

    expect(r.status).toBe(409);
    expect(r.body.message).toContain("borrador");
  });

  it("makes a recalibration prompt only once there is data", async () => {
    const none = await call("GET", admin("/recalibration"));

    expect(none.body).toMatchObject({ offer: false, daysOfData: 0 });

    await goLive();
    const fresh = await call("GET", admin("/recalibration"));

    // Live for seconds: not enough data to say anything, and it says so.
    expect(fresh.body.offer).toBe(false);
    expect(fresh.body.reason).toContain("90");
    expect(fresh.body.used).toMatchObject({ ticket: 65 });
  });
});

describe("a centre's own staff", () => {
  it("has no programme to show until one is published", async () => {
    const r = await call("GET", `/clinics/${SLUG}/program`);

    expect(r.status).toBe(404);
    expect(r.body.message).toContain("todavía no tiene un programa activo");
  });

  it("answers 404 for an unknown poster slug", async () => {
    expect((await call("GET", "/clinics/no-such-slug/program")).status).toBe(404);
  });

  it("records a visit and returns what it did", async () => {
    await goLive();
    const m = await newMember();
    const r = await call("POST", `/clinics/${SLUG}/members/${m.id}/visits`, {
      kind: "PAYMENT",
      lines: [{ amountEuro: 65 }],
      idempotencyKey: "route-visit-1"
    });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ progress: 65, duplicate: false, lifetimeAfter: 65 });
    expect(r.body.issued.length).toBeGreaterThan(0);
  });

  it("states the visit in points, ten per euro (founders' E2E 48-49)", async () => {
    await goLive();
    const m = await newMember();
    const r = await call("POST", `/clinics/${SLUG}/members/${m.id}/visits`, {
      kind: "PAYMENT",
      lines: [{ amountEuro: 60 }],
      idempotencyKey: "route-visit-points"
    });

    expect(r.body).toMatchObject({ points: 600, pointsTotal: 600 });
  });

  it("counts a product bought with the treatment: 60 + 40 euros is 1000 points", async () => {
    await goLive();
    const m = await newMember();
    const r = await call("POST", `/clinics/${SLUG}/members/${m.id}/visits`, {
      kind: "PAYMENT",
      lines: [{ amountEuro: 60 }, { amountEuro: 40, category: "COS" }],
      idempotencyKey: "route-visit-product"
    });

    expect(r.body).toMatchObject({ progress: 100, points: 1000, pointsTotal: 1000 });
  });

  it("gives the visit form the centre's catalogue with no cost in it", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const r = await call("GET", `/clinics/${SLUG}/catalog`);

    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(fixtureItems.length);
    expect(r.body.items.find((i: { externalId: string }) => i.externalId === "F2")).toEqual({
      externalId: "F2",
      name: expect.any(String),
      priceEuro: 75,
      category: "APF",
      isProduct: false
    });
    expect(JSON.stringify(r.body)).not.toMatch(/cost/i);
  });

  it("answers a retry with the same result and not an error", async () => {
    await goLive();
    const m = await newMember();
    const send = () =>
      call("POST", `/clinics/${SLUG}/members/${m.id}/visits`, {
        kind: "PAYMENT",
        lines: [{ amountEuro: 65 }],
        idempotencyKey: "route-visit-retry"
      });

    const first = await send();
    const second = await send();

    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.visitId).toBe(first.body.visitId);
    expect(await db.pointsTransaction.count({ where: { memberId: m.id } })).toBe(1);
  });

  it("reports a refusal as the sentence reception needs, not as a 500", async () => {
    // THE bug this file exists for. An error that is not an AppError answers
    // "Internal server error", hiding the one line a receptionist can act on.
    const m = await newMember();
    const r = await call("POST", `/clinics/${SLUG}/members/${m.id}/visits`, {
      kind: "PAYMENT",
      lines: [{ amountEuro: 65 }],
      idempotencyKey: "route-no-program"
    });

    expect(r.status).toBe(409);
    expect(r.body.message).toContain("todavía no tiene un programa activo");
    expect(r.body.message).not.toBe("Internal server error");
  });

  it("validates a visit before touching anything", async () => {
    await goLive();
    const m = await newMember();
    const path = `/clinics/${SLUG}/members/${m.id}/visits`;

    expect(
      (await call("POST", path, { kind: "PAYMENT", lines: [], idempotencyKey: "k-123456" })).status
    ).toBe(422);
    expect(
      (await call("POST", path, { kind: "PAYMENT", lines: [{ amountEuro: 10 }] })).status
    ).toBe(422);
    expect(
      (
        await call("POST", path, {
          kind: "PAYMENT",
          lines: [{ amountEuro: -3 }],
          idempotencyKey: "k-123456"
        })
      ).status
    ).toBe(422);
    expect(
      (
        await call("POST", path, {
          kind: "REGALO",
          lines: [{ amountEuro: 3 }],
          idempotencyKey: "k-123456"
        })
      ).status
    ).toBe(422);
  });

  it("does not let the caller choose the visit's source", async () => {
    await goLive();
    const m = await newMember();
    const r = await call("POST", `/clinics/${SLUG}/members/${m.id}/visits`, {
      kind: "PAYMENT",
      lines: [{ amountEuro: 20 }],
      idempotencyKey: "route-source-1",
      source: "INTEGRATION"
    });

    expect(r.status).toBe(200);
    // Whatever was claimed, only reception-typed visits exist.
    expect((await db.paidVisit.findFirstOrThrow({ where: { memberId: m.id } })).source).toBe(
      "STAFF_ENTRY"
    );
  });

  it("answers 404 in Spanish for a member who is not here", async () => {
    await goLive();
    const r = await call("POST", `/clinics/${SLUG}/members/ghost/visits`, {
      kind: "PAYMENT",
      lines: [{ amountEuro: 20 }],
      idempotencyKey: "route-ghost-1"
    });

    expect(r.status).toBe(404);
    expect(r.body.message).toBe("No existe esa clienta en este centro.");
  });

  it("records a prepaid package session", async () => {
    await goLive();
    const m = await newMember();
    const r = await call("POST", `/clinics/${SLUG}/members/${m.id}/visits`, {
      kind: "BONO_SESSION",
      package: { priceEuro: 300, sessions: 6 },
      idempotencyKey: "route-bono-1"
    });

    expect(r.status).toBe(200);
    expect(r.body.progress).toBe(50);
  });

  it("lists rewards, then redeems one against today's visit", async () => {
    await goLive();
    const m = await newMember();
    const visit = await call("POST", `/clinics/${SLUG}/members/${m.id}/visits`, {
      kind: "PAYMENT",
      lines: [{ amountEuro: 65 }],
      idempotencyKey: "route-redeem-1"
    });

    const list = await call("GET", `/clinics/${SLUG}/members/${m.id}/rewards`);

    expect(list.body.rewards[0].status).toBe("disponible");

    const rewardId = list.body.rewards[0].id;
    const redeemed = await call(
      "POST",
      `/clinics/${SLUG}/members/${m.id}/rewards/${rewardId}/redeem`,
      { visitId: visit.body.visitId }
    );

    expect(redeemed.status).toBe(200);
    expect(redeemed.body.status).toBe("canjeado");
  });

  it("refuses a redemption with no visit named, and a repeat, with the reason", async () => {
    await goLive();
    const m = await newMember();
    const visit = await call("POST", `/clinics/${SLUG}/members/${m.id}/visits`, {
      kind: "PAYMENT",
      lines: [{ amountEuro: 65 }],
      idempotencyKey: "route-redeem-2"
    });
    const rewardId = (await call("GET", `/clinics/${SLUG}/members/${m.id}/rewards`)).body.rewards[0]
      .id;
    const path = `/clinics/${SLUG}/members/${m.id}/rewards/${rewardId}/redeem`;

    const noVisit = await call("POST", path, {});

    expect(noVisit.status).toBe(422);

    await call("POST", path, { visitId: visit.body.visitId });
    const again = await call("POST", path, { visitId: visit.body.visitId });

    expect(again.status).toBe(409);
    expect(again.body.message).toBe("Este premio ya se canjeó.");
  });

  it("will not redeem a reward through another member's URL", async () => {
    await goLive();
    const owner = await newMember();
    const other = await newMember();
    const visit = await call("POST", `/clinics/${SLUG}/members/${owner.id}/visits`, {
      kind: "PAYMENT",
      lines: [{ amountEuro: 65 }],
      idempotencyKey: "route-scope-1"
    });
    const rewardId = (await call("GET", `/clinics/${SLUG}/members/${owner.id}/rewards`)).body
      .rewards[0].id;

    const r = await call(
      "POST",
      `/clinics/${SLUG}/members/${other.id}/rewards/${rewardId}/redeem`,
      { visitId: visit.body.visitId }
    );

    expect(r.status).toBe(404);
  });
});

describe("adding points by hand, at a clinic on a programme", () => {
  const credited: string[] = [];
  const fake = {
    credit: async () => {
      credited.push("credit");

      return { applied: true, balance: { spendable: 1, lifetime: 1 }, tier: null };
    },
    redeem: async () => {
      credited.push("redeem");

      return { applied: true, balance: { spendable: 0, lifetime: 1 }, tier: null };
    },
    clawBack: async () => {
      credited.push("clawBack");

      return { applied: true, balance: { spendable: 0, lifetime: 0 }, tier: null };
    }
  } as unknown as PointsService;

  const pointsApp = (usesProgram: boolean | undefined): Express => {
    const a = express();

    a.use(express.json());
    a.use(
      "/api/v1",
      createPointsRouter({
        points: fake,
        clinicOfMember: async () => clinic.id,
        ...(usesProgram === undefined ? {} : { usesProgram: async () => usesProgram })
      })
    );
    a.use(errorHandler);

    return a;
  };

  const post = async (a: Express, path: string, body: unknown): Promise<Reply> => {
    const server = a.listen(0);

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });

      return { status: response.status, body: await response.json() };
    } finally {
      server.close();
    }
  };

  const credit = { points: 10, kind: PointsTransactionKind.EARN, idempotencyKey: "key-123456" };

  beforeEach(() => {
    credited.length = 0;
  });

  it("refuses to credit, because only a recorded visit applies the programme's rules", async () => {
    const r = await post(pointsApp(true), "/members/m1/points/credit", credit);

    expect(r.status).toBe(409);
    expect(r.body.message).toContain("registra la visita");
    expect(credited).toEqual([]);
  });

  it("refuses to spend points, which no longer exist as a currency there", async () => {
    const r = await post(pointsApp(true), "/members/m1/points/redeem", {
      points: 5,
      idempotencyKey: "key-123456"
    });

    expect(r.status).toBe(409);
    expect(credited).toEqual([]);
  });

  it("still allows a correction, which is how a mistake gets undone", async () => {
    // In points, the unit the screens show: 50 points is 5 euros of progress.
    const r = await post(pointsApp(true), "/members/m1/points/claw-back", {
      points: 50,
      idempotencyKey: "key-123456",
      reason: "Error"
    });

    expect(r.status).toBe(200);
    expect(credited).toEqual(["clawBack"]);
  });

  it("changes nothing for a clinic with no programme", async () => {
    expect((await post(pointsApp(false), "/members/m1/points/credit", credit)).status).toBe(200);
    expect(credited).toEqual(["credit"]);
  });

  it("changes nothing when programmes are not configured at all", async () => {
    expect((await post(pointsApp(undefined), "/members/m1/points/credit", credit)).status).toBe(
      200
    );
    expect(credited).toEqual(["credit"]);
  });
});

describe("ticket and visits typed by the centre", () => {
  it("tells the screen the ranges a figure may take", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const r = await call("GET", admin("/estimates"));

    expect(r.body.limits).toEqual({
      ticket: { min: 10, max: 1000 },
      visits: { min: 0.5, max: 26 }
    });
  });

  it("builds a different programme from the exact figures, and says so in the answers it stores", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const plain = await call("POST", admin("/programs"), ANSWERS);
    const typed = await call("POST", admin("/programs"), {
      ...ANSWERS,
      ticketValue: 80,
      visitsValue: 4
    });

    expect(typed.status).toBe(201);
    expect(typed.body.program.estimates).toMatchObject({
      ticket: 80,
      visitsPerYear: 4,
      annualSpend: 320
    });
    expect(typed.body.answers).toMatchObject({ ticketValue: 80, visitsValue: 4 });
    expect(typed.body.program.ladder).not.toEqual(plain.body.program.ladder);
  });

  it("returns to the original programme when the figures are cleared", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const plain = await call("POST", admin("/preview"), ANSWERS);
    const reset = await call("POST", admin("/preview"), {
      ...ANSWERS,
      ticketValue: null,
      visitsValue: null
    });

    expect(reset.body.program).toEqual(plain.body.program);
  });

  it("previews exactly what saving would store, with the figures typed", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const typed = { ...ANSWERS, ticketValue: 90, visitsValue: 4.5 };
    const preview = await call("POST", admin("/preview"), typed);
    const saved = await call("POST", admin("/programs"), typed);

    expect(preview.body.program).toEqual(saved.body.program);
  });

  it("refuses a figure outside the ranges, in Spanish and as a 422", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });

    for (const [extra, text] of [
      [{ ticketValue: 9 }, "entre 10 y 1.000"],
      [{ ticketValue: 1001 }, "entre 10 y 1.000"],
      [{ ticketValue: 65.5 }, "número entero"],
      [{ visitsValue: 0.4 }, "entre 0,5 y 26"],
      [{ visitsValue: 27 }, "entre 0,5 y 26"]
    ] as const) {
      const r = await call("POST", admin("/preview"), { ...ANSWERS, ...extra });

      expect(r.status, JSON.stringify(extra)).toBe(422);
      expect(r.body.message).toContain(text);
    }
  });

  it("flags figures far from the catalogue and refuses to publish them", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), {
      ...ANSWERS,
      ticketValue: 300,
      visitsValue: 5.1
    });

    expect(draft.body.program.review.join(" ")).toContain("Con tus respuestas");

    const live = await call("POST", admin(`/programs/${draft.body.id}/publish`));

    expect(live.status).toBe(409);
  });
});

describe("what a centre sees of a stored programme", () => {
  it("carries no gift value, shows real spend and minimum revenue, and marks Family & Friends", async () => {
    await goLive();
    const staff = await call("GET", `/clinics/${SLUG}/program`);
    const program = staff.body.program;

    expect(JSON.stringify(program)).not.toMatch(/"value"|"cost|"budget/i);
    expect(program.ladder.at(-1).realSpend).toBe(1500);
    expect(program.referrals.find((r: { n: number }) => r.n === 10).minRevenue).toBe(650);
    expect(program.familyAndFriends.comingSoon).toBe(true);
  });
});

describe("benefits the centre writes for a tier (founders' E2E item 27)", () => {
  const benefitsPath = (programId: string, tier: string) =>
    admin(`/programs/${programId}/tiers/${tier}/benefits`);

  it("stores them on a draft and shows them after the derived ones", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);
    const r = await call("PUT", benefitsPath(draft.body.id, "oro"), {
      benefits: ["Café de bienvenida", "Parking gratis"]
    });

    expect(r.status).toBe(200);

    const oro = r.body.program.tiers.find((t: { key: string }) => t.key === "oro");

    expect(oro.customBenefits).toEqual(["Café de bienvenida", "Parking gratis"]);
    expect(oro.benefits.slice(-2)).toEqual(["Café de bienvenida", "Parking gratis"]);
    expect(JSON.stringify(r.body.program)).not.toMatch(/"cost|costPct/i);
  });

  it("removes them again when the list is emptied", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);

    await call("PUT", benefitsPath(draft.body.id, "plata"), { benefits: ["Algo"] });
    const r = await call("PUT", benefitsPath(draft.body.id, "plata"), { benefits: [] });

    expect(
      r.body.program.tiers.find((t: { key: string }) => t.key === "plata").customBenefits
    ).toEqual([]);
  });

  it("refuses blank, over-long and too many, and an unknown tier", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);
    const id = draft.body.id as string;

    expect((await call("PUT", benefitsPath(id, "oro"), { benefits: [" "] })).status).toBe(422);
    expect(
      (await call("PUT", benefitsPath(id, "oro"), { benefits: ["x".repeat(81)] })).status
    ).toBe(422);
    expect(
      (await call("PUT", benefitsPath(id, "oro"), { benefits: Array(7).fill("a") })).status
    ).toBe(422);
    expect((await call("PUT", benefitsPath(id, "mitico"), { benefits: ["a"] })).status).toBe(422);
  });

  it("refuses to edit a programme that is already live", async () => {
    const id = await goLive();
    const r = await call("PUT", benefitsPath(id, "oro"), { benefits: ["Tarde"] });

    expect(r.status).toBe(409);
  });
});

describe("giving a milestone any catalogue item (founders' E2E item 28)", () => {
  it("accepts a catalogue item the engine did not propose, and refuses one that cannot be a reward", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);
    const first = draft.body.program.ladder.find((m: { reward: unknown }) => m.reward) as {
      n: number;
      reward: { name: string };
    };
    const path = admin(`/programs/${draft.body.id}/milestones/${first.n}`);

    // The first milestone sits in Bronce, which is exempt from ordering, so some item fits.
    let swapped: { name: string } | null = null;

    for (const item of fixtureItems) {
      const r = await call("PATCH", path, { itemId: item.externalId });

      if (r.status === 200) {
        swapped = { name: item.name };
        const now = r.body.program.ladder.find((m: { n: number }) => m.n === first.n);

        expect(now.reward.name).toContain(item.name);
        break;
      }
    }

    expect(swapped).not.toBeNull();
    expect((await call("PATCH", path, { itemId: "no-such-item" })).status).toBe(409);
  });
});

describe("the five-year calculator", () => {
  const calc = (programId: string, body?: unknown) =>
    call("POST", admin(`/programs/${programId}/calculator`), body ?? {});

  it("answers for a draft with the programme's own defaults", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);
    const r = await calc(draft.body.id);

    expect(r.status).toBe(200);
    expect(r.body.years).toHaveLength(5);
    expect(r.body.input).toEqual({ clients: 300, ticket: 65 });
    expect(r.body.defaults).toEqual({ clients: 300, ticket: 65 });
    expect(Math.round(r.body.years[0].avgMembers)).toBe(163);
    expect(Math.round(r.body.years[4].net)).toBe(11380);
  });

  it("follows the inputs and leaves the stored programme untouched", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);
    const before = await call("GET", admin(`/programs/${draft.body.id}`));
    const r = await calc(draft.body.id, { clients: 150, ticket: 100 });

    expect(r.body.input).toEqual({ clients: 150, ticket: 100 });
    expect(r.body.defaults).toEqual({ clients: 300, ticket: 65 });
    expect(Math.round(r.body.years[4].avgMembers)).toBe(150);

    const after = await call("GET", admin(`/programs/${draft.body.id}`));

    expect(after.body).toEqual(before.body);
  });

  it("works on the live programme", async () => {
    const id = await goLive();

    expect((await calc(id)).status).toBe(200);
  });

  it("sends only yearly totals, never anything about an individual gift", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);
    const r = await calc(draft.body.id);

    expect(JSON.stringify(r.body)).not.toMatch(/"value"|"cost"|"items"|"reward"|"name"/i);
  });

  it("refuses figures outside the ranges in Spanish, and an unknown programme", async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = await call("POST", admin("/programs"), ANSWERS);

    const few = await calc(draft.body.id, { clients: 5 });
    const cheap = await calc(draft.body.id, { ticket: 5 });
    const text = await calc(draft.body.id, { clients: "muchos" });
    const ghost = await calc("00000000-0000-4000-8000-00000000dead");

    expect(few.status).toBe(422);
    expect(few.body.message).toContain("entre 10 y 5000");
    expect(cheap.status).toBe(422);
    expect(cheap.body.message).toContain("entre 10 y 1000");
    expect(text.status).toBe(422);
    expect(text.body.message).toContain("tienen que ser un número");
    expect(ghost.status).toBe(404);
  });
});

describe("replacing a live programme with a new version", () => {
  const pay = async (memberId: string, euros: number, key: string) => {
    const r = await call("POST", `/clinics/${SLUG}/members/${memberId}/visits`, {
      kind: "PAYMENT",
      lines: [{ amountEuro: euros }],
      idempotencyKey: key
    });

    // Asserted here so a refused visit fails the test that made it, not a later assertion about
    // its effects: a too-short key once made these visits vanish without a word.
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    return r;
  };

  /** Draft with the given figures, published, replacing whatever was live. */
  const replaceWith = async (figures: { ticketValue: number; visitsValue: number }) => {
    const draft = await call("POST", admin("/programs"), { ...ANSWERS, ...figures });
    const live = await call("POST", admin(`/programs/${draft.body.id}/publish`));

    expect(live.status, JSON.stringify(live.body)).toBe(200);

    return draft.body;
  };

  it("keeps each member's progress and moves her up to the tier it now earns, never down", async () => {
    await goLive();
    const climber = await newMember();
    const holder = await newMember();

    // 150 € is short of Plata at 190 € under the first version; 300 € is past it.
    await pay(climber.id, 150, "visit-key-climber");
    await pay(holder.id, 300, "visit-key-holder");

    const tierOf = async (id: string) =>
      (await db.member.findUniqueOrThrow({ where: { id }, select: { tier: true } })).tier;

    expect(await tierOf(climber.id)).not.toBe("Plata");
    expect(await tierOf(holder.id)).toBe("Plata");

    // A cheaper ladder: Plata now starts at 120 €. Nobody has done anything since.
    await replaceWith({ ticketValue: 40, visitsValue: 3 });

    expect(await tierOf(climber.id)).toBe("Plata");

    const lifetime = async (id: string) =>
      (
        await db.pointsTransaction.aggregate({
          where: { memberId: id },
          _sum: { points: true }
        })
      )._sum.points;

    expect(await lifetime(climber.id)).toBe(150);
    expect(await lifetime(holder.id)).toBe(300);

    // A dearer ladder: Plata now starts above what the holder has paid. She keeps it.
    await replaceWith({ ticketValue: 120, visitsValue: 6 });

    expect(await tierOf(holder.id)).toBe("Plata");
    expect(await lifetime(holder.id)).toBe(300);
  });

  it("places existing members on the ladder at a centre's first programme, balances untouched", async () => {
    const m = await newMember();

    await db.pointsTransaction.create({
      data: {
        memberId: m.id,
        clinicId: clinic.id,
        kind: PointsTransactionKind.EARN,
        points: 500,
        reason: "antes del programa",
        idempotencyKey: "before-program"
      }
    });
    await db.member.update({ where: { id: m.id }, data: { tier: "Bronze" } });
    await goLive();

    // "Bronze" is the old scheme's name and reads as no tier; she is placed by her progress (500
    // euros) on the programme's own ladder. Her balance is carried as stored, not converted.
    const row = await db.member.findUniqueOrThrow({ where: { id: m.id } });

    const ledger = await db.pointsTransaction.aggregate({
      where: { memberId: m.id },
      _sum: { points: true }
    });

    expect(row.tier).toBe("Plata");
    expect(ledger._sum.points).toBe(500);
  });

  it("keeps rewards already issued, and still issues the new version's own", async () => {
    await goLive();
    const m = await newMember();

    await pay(m.id, 150, "visit-key-v1");

    const issuedUnderV1 = await db.memberReward.findMany({ where: { memberId: m.id } });

    expect(issuedUnderV1.length).toBeGreaterThan(0);
    expect(issuedUnderV1.every((r) => r.sourceKey.startsWith("v1:"))).toBe(true);

    const v2 = await replaceWith({ ticketValue: 40, visitsValue: 3 });

    // Nothing is issued by the switch itself, and what was issued is untouched.
    expect(await db.memberReward.count({ where: { memberId: m.id } })).toBe(issuedUnderV1.length);

    const second = await pay(m.id, 250, "visit-key-v2");
    const all = await db.memberReward.findMany({ where: { memberId: m.id } });
    const underV2 = all.filter((r) => r.sourceKey.startsWith("v2:"));

    // Exactly the steps of the new ladder between what she had and what she has now, as progress:
    // steps she had already passed on the new ladder are not issued again. The range comes from
    // the visit itself, because a double-points perk issued under the first version is still
    // waiting and doubles this payment.
    const { lifetimeBefore, lifetimeAfter } = second.body;
    const expected = (v2.program.ladder as Array<{ type: string; threshold: number }>).filter(
      (s) => s.type !== "nivel" && s.threshold > lifetimeBefore && s.threshold <= lifetimeAfter
    );

    expect(expected.length).toBeGreaterThan(0);
    expect(underV2).toHaveLength(expected.length);
    expect(all.filter((r) => r.sourceKey.startsWith("v1:"))).toHaveLength(issuedUnderV1.length);
    expect(new Set(all.map((r) => r.sourceKey)).size).toBe(all.length);
  });

  it("lets a reward issued under the old version be redeemed under the new one", async () => {
    await goLive();
    const m = await newMember();

    await pay(m.id, 65, "visit-key-old");

    const premio = (await db.memberReward.findMany({ where: { memberId: m.id } })).find(
      (r) => r.kind === "PREMIO"
    )!;

    await replaceWith({ ticketValue: 40, visitsValue: 3 });

    const visit = await pay(m.id, 40, "visit-key-new");
    const redeemed = await call(
      "POST",
      `/clinics/${SLUG}/members/${m.id}/rewards/${premio.id}/redeem`,
      { visitId: visit.body.visitId }
    );

    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200);
  });
});

describe("texts the centre edits on a draft", () => {
  const textsPath = (programId: string) => admin(`/programs/${programId}/texts`);
  const OTHER_SLUG = "test-route-other";
  let other: Clinic;

  beforeAll(async () => {
    other = await db.clinic.upsert({
      where: { slug: OTHER_SLUG },
      update: {},
      create: {
        slug: OTHER_SLUG,
        name: "Otro centro",
        addressLine: "Calle Cinco 5",
        pincode: "28005"
      }
    });
  });

  afterAll(async () => {
    await db.onboardingProgram.deleteMany({ where: { clinicId: other.id } });
    await db.clinic.deleteMany({ where: { slug: OTHER_SLUG } });
  });

  const newDraft = async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });

    return (await call("POST", admin("/programs"), ANSWERS)).body;
  };

  const perkOf = (body: { program: { ladder: Array<{ n: number; perk?: unknown }> } }) =>
    body.program.ladder.find((m) => m.perk) as {
      n: number;
      perk: { kind: string; name: string; description: string };
    };

  const rewardOf = (body: { program: { ladder: Array<{ n: number; reward?: unknown }> } }) =>
    body.program.ladder.find((m) => m.reward) as {
      n: number;
      reward: { name: string; items: unknown[] };
    };

  it("applies referral, perk, reward and recurring edits and returns the programme", async () => {
    const draft = await newDraft();
    const perk = perkOf(draft);
    const reward = rewardOf(draft);
    const r = await call("PATCH", textsPath(draft.id), {
      referral: [{ index: 0, name: "  Sesión de bienvenida  " }],
      perks: [{ milestone: perk.n, name: "Ventaja propia", desc: "Descripción propia" }],
      rewards: [{ milestone: reward.n, label: "Premio propio" }],
      recurring: { label: "Recurrente propio" }
    });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.program.referrals[0].name).toBe("Sesión de bienvenida");
    expect(r.body.program.referrals[0].n).toBe(draft.program.referrals[0].n);

    const perkAfter = perkOf(r.body);

    expect(perkAfter.perk).toEqual({
      kind: perk.perk.kind,
      name: "Ventaja propia",
      description: "Descripción propia"
    });

    const rewardAfter = rewardOf(r.body);

    expect(rewardAfter.reward.name).toBe("Premio propio");
    expect(rewardAfter.reward.items).toEqual(reward.reward.items);
    expect(r.body.program.recurring.name).toBe("Recurrente propio");
    expect(JSON.stringify(r.body.program)).not.toMatch(/"cost|costPct/i);

    const again = await call("GET", admin(`/programs/${draft.id}`));

    expect(again.body.program.recurring.name).toBe("Recurrente propio");
  });

  it("clears a label with null and returns to the generated title", async () => {
    const draft = await newDraft();
    const reward = rewardOf(draft);

    await call("PATCH", textsPath(draft.id), {
      rewards: [{ milestone: reward.n, label: "Temporal" }],
      recurring: { label: "Temporal" }
    });
    const r = await call("PATCH", textsPath(draft.id), {
      rewards: [{ milestone: reward.n, label: null }],
      recurring: { label: null }
    });

    expect(r.status).toBe(200);
    expect(rewardOf(r.body).reward.name).toBe(reward.reward.name);
    expect(r.body.program.recurring.name).toBe(draft.program.recurring.name);
  });

  it("refuses empty, over-long, control characters and an empty body, with 422", async () => {
    const draft = await newDraft();
    const reward = rewardOf(draft);
    const send = (body: unknown) => call("PATCH", textsPath(draft.id), body);

    expect((await send({ referral: [{ index: 0, name: "   " }] })).status).toBe(422);
    expect((await send({ referral: [{ index: 0, name: "x".repeat(121) }] })).status).toBe(422);
    expect((await send({ referral: [{ index: 0, name: "a\u0007b" }] })).status).toBe(422);
    expect((await send({ rewards: [{ milestone: reward.n, label: "" }] })).status).toBe(422);
    expect((await send({ perks: [{ milestone: perkOf(draft).n }] })).status).toBe(422);
    expect((await send({})).status).toBe(422);

    // Nothing was stored by any of those.
    const after = await call("GET", admin(`/programs/${draft.id}`));

    expect(after.body.program.referrals[0].name).toBe(draft.program.referrals[0].name);
  });

  it("answers 422 in Spanish for a step, perk or reward that does not exist, and stores nothing", async () => {
    const draft = await newDraft();
    const send = (body: unknown) => call("PATCH", textsPath(draft.id), body);

    const referral = await send({
      referral: [
        { index: 0, name: "Valido" },
        { index: 42, name: "No existe" }
      ]
    });
    const perk = await send({ perks: [{ milestone: 9999, name: "X" }] });
    const reward = await send({ rewards: [{ milestone: 9999, label: "X" }] });

    for (const r of [referral, perk, reward]) {
      expect(r.status).toBe(422);
      expect(r.body.message).toMatch(/^No existe|^Ese hito/);
    }

    // All or nothing: the valid first edit of the failing request was not kept.
    const after = await call("GET", admin(`/programs/${draft.id}`));

    expect(after.body.program.referrals[0].name).toBe(draft.program.referrals[0].name);
  });

  it("refuses a programme that is not a draft, with the same 409 as the other edits", async () => {
    const id = await goLive();
    const r = await call("PATCH", textsPath(id), { referral: [{ index: 0, name: "Tarde" }] });

    expect(r.status).toBe(409);
    expect(r.body.message).toContain("borrador");
  });

  it("answers 404 for another clinic's programme and for an unknown programme or clinic", async () => {
    const draft = await newDraft();
    const body = { referral: [{ index: 0, name: "Intruso" }] };
    const viaOther = await call(
      "PATCH",
      `/admin/clinics/${other.id}/onboarding/programs/${draft.id}/texts`,
      body
    );
    const unknown = await call("PATCH", textsPath("no-such-program"), body);
    const noClinic = await call(
      "PATCH",
      `/admin/clinics/no-such/onboarding/programs/${draft.id}/texts`,
      body
    );

    expect(viaOther.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(noClinic.status).toBe(404);

    const after = await call("GET", admin(`/programs/${draft.id}`));

    expect(after.body.program.referrals[0].name).toBe(draft.program.referrals[0].name);
  });

  it("answers the benefits route's conflict when the draft changed under the editor", async () => {
    const draft = await newDraft();
    const stale = await onboarding.getProgram(clinic.id, draft.id);

    // Someone else saves first, which moves updatedAt.
    await call("PUT", admin(`/programs/${draft.id}/tiers/oro/benefits`), { benefits: ["Otro"] });

    const spy = vi.spyOn(onboarding, "getProgram").mockResolvedValueOnce(stale);

    try {
      const r = await call("PATCH", textsPath(draft.id), {
        referral: [{ index: 0, name: "Perdida" }]
      });

      expect(r.status).toBe(409);
      expect(r.body.message).toBe(
        "El borrador ha cambiado mientras lo editabas. Recarga la página y vuelve a intentarlo."
      );
    } finally {
      spy.mockRestore();
    }

    const after = await call("GET", admin(`/programs/${draft.id}`));

    expect(after.body.program.referrals[0].name).toBe(draft.program.referrals[0].name);
  });

  it("is dropped for a reward when that reward is swapped", async () => {
    const draft = await newDraft();
    const alt = draft.program.ladder.find(
      (m: { reward?: { alternatives: unknown[] } }) => m.reward?.alternatives.length
    ) as { n: number; reward: { alternatives: Array<{ name: string }> } };

    await call("PATCH", textsPath(draft.id), { rewards: [{ milestone: alt.n, label: "Mio" }] });
    const r = await call("PATCH", admin(`/programs/${draft.id}/milestones/${alt.n}`), {
      alternative: 0
    });

    expect(r.status).toBe(200);
    expect(r.body.program.ladder.find((m: { n: number }) => m.n === alt.n).reward.name).toBe(
      alt.reward.alternatives[0].name
    );
  });

  it("carries edited texts through publishing into both views, and leaves issued rewards alone", async () => {
    const draft = await newDraft();
    const perk = perkOf(draft);
    const reward = rewardOf(draft);

    await call("PATCH", textsPath(draft.id), {
      referral: [{ index: 0, name: "Referido propio" }],
      perks: [{ milestone: perk.n, name: "Ventaja propia", desc: "Descripción propia" }],
      rewards: [{ milestone: reward.n, label: "Premio propio" }],
      recurring: { label: "Recurrente propio" }
    });

    const published = await call("POST", admin(`/programs/${draft.id}/publish`));

    expect(published.status).toBe(200);

    // The centre's view of the live programme.
    const staff = await call("GET", `/clinics/${SLUG}/program`);

    expect(staff.body.program.referrals[0].name).toBe("Referido propio");
    expect(perkOf(staff.body).perk.name).toBe("Ventaja propia");
    expect(perkOf(staff.body).perk.description).toBe("Descripción propia");
    expect(rewardOf(staff.body).reward.name).toBe("Premio propio");
    expect(staff.body.program.recurring.name).toBe("Recurrente propio");

    // The runtime view, read from what is stored.
    const live = await onboarding.active(clinic.id);
    const output = live!.output as unknown as Program;
    const view = programView(output);

    expect(view.referral[0].title).toBe("Referido propio");
    expect(view.recurring.title).toBe("Recurrente propio");
    expect(view.milestones.find((m) => m.n === perk.n)!.issue!.title).toBe("Ventaja propia");
    expect(view.milestones.find((m) => m.n === reward.n)!.issue!.title).toBe("Premio propio");
    expect(presentProgram(output).recurring.name).toBe(view.recurring.title);
  });
});

describe("a new draft that keeps the edits (clone)", () => {
  const OTHER_SLUG = "test-route-clone-other";
  let other: Clinic;

  beforeAll(async () => {
    other = await db.clinic.upsert({
      where: { slug: OTHER_SLUG },
      update: {},
      create: {
        slug: OTHER_SLUG,
        name: "Otro centro",
        addressLine: "Calle Seis 6",
        pincode: "28006"
      }
    });
  });

  afterAll(async () => {
    await db.onboardingProgram.deleteMany({ where: { clinicId: other.id } });
    await db.clinic.deleteMany({ where: { slug: OTHER_SLUG } });
  });

  const clonePath = (programId: string) => admin(`/programs/${programId}/draft`);

  /** A published programme that carries every kind of edit the centre can make. */
  const editedLive = async () => {
    await call("PUT", admin("/catalog"), { items: fixtureItems });
    const draft = (await call("POST", admin("/programs"), ANSWERS)).body;
    const swappable = draft.program.ladder.find(
      (m: { reward?: { alternatives: unknown[] } }) => m.reward?.alternatives.length
    ) as { n: number };
    const labelled = draft.program.ladder.find(
      (m: { n: number; reward?: unknown }) => m.reward && m.n !== swappable.n
    ) as { n: number };

    await call("PUT", admin(`/programs/${draft.id}/tiers/oro/benefits`), {
      benefits: ["Café de bienvenida"]
    });
    await call("PATCH", admin(`/programs/${draft.id}/milestones/${swappable.n}`), {
      alternative: 0
    });
    await call("PATCH", admin(`/programs/${draft.id}/texts`), {
      referral: [{ index: 0, name: "Referido propio" }],
      rewards: [{ milestone: labelled.n, label: "Premio propio" }],
      recurring: { label: "Recurrente propio" }
    });
    expect((await call("POST", admin(`/programs/${draft.id}/publish`))).status).toBe(200);

    return draft.id as string;
  };

  it("copies the programme verbatim into a new draft, one version up", async () => {
    const liveId = await editedLive();
    const r = await call("POST", clonePath(liveId));

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe("BORRADOR");
    expect(r.body.version).toBe(2);
    expect(r.body.id).not.toBe(liveId);
    expect(r.body.publishedAt).toBeNull();

    const live = await call("GET", admin(`/programs/${liveId}`));

    expect(r.body.program).toEqual(live.body.program);
    expect(r.body.answers).toEqual(live.body.answers);
    expect(r.body.program.referrals[0].name).toBe("Referido propio");
    expect(r.body.program.recurring.name).toBe("Recurrente propio");
    expect(
      r.body.program.tiers.find((t: { key: string }) => t.key === "oro").customBenefits
    ).toEqual(["Café de bienvenida"]);

    // The stored JSON is identical, not merely the presentation of it.
    const rows = await db.onboardingProgram.findMany({ where: { clinicId: clinic.id } });
    const [a, b] = [liveId, r.body.id].map((id) => rows.find((x) => x.id === id)!);

    expect(b.output).toEqual(a.output);
    expect(b.catalogSnapshot).toEqual(a.catalogSnapshot);
    expect(b.engineVersion).toBe(a.engineVersion);
    expect(b.configVersion).toBe(a.configVersion);

    // The live version is untouched.
    expect(a.status).toBe("ACTIVO");
  });

  it("lets the new draft be edited and published, retiring the old version", async () => {
    const liveId = await editedLive();
    const draft = (await call("POST", clonePath(liveId))).body;
    const edit = await call("PATCH", admin(`/programs/${draft.id}/texts`), {
      referral: [{ index: 0, name: "Segunda versión" }]
    });

    expect(edit.status).toBe(200);
    expect((await call("GET", admin(`/programs/${liveId}`))).body.program.referrals[0].name).toBe(
      "Referido propio"
    );
    expect((await call("POST", admin(`/programs/${draft.id}/publish`))).status).toBe(200);
    expect((await call("GET", `/clinics/${SLUG}/program`)).body.program.referrals[0].name).toBe(
      "Segunda versión"
    );
  });

  it("refuses with 409 while a draft already exists", async () => {
    const liveId = await editedLive();

    expect((await call("POST", clonePath(liveId))).status).toBe(201);

    const again = await call("POST", clonePath(liveId));

    expect(again.status).toBe(409);
    expect(again.body.message).toContain("borrador");
    expect(await db.onboardingProgram.count({ where: { clinicId: clinic.id } })).toBe(2);
  });

  it("answers 404 for a programme of another clinic or one that does not exist", async () => {
    const liveId = await editedLive();
    const viaOther = await call(
      "POST",
      `/admin/clinics/${other.id}/onboarding/programs/${liveId}/draft`
    );

    expect(viaOther.status).toBe(404);
    expect((await call("POST", clonePath("no-such-program"))).status).toBe(404);
    expect(await db.onboardingProgram.count({ where: { clinicId: other.id } })).toBe(0);
  });

  it("leaves createDraft as it was: a fresh engine run that drops the edits", async () => {
    const liveId = await editedLive();
    const fresh = await call("POST", admin("/programs"), ANSWERS);

    expect(fresh.status).toBe(201);
    expect(fresh.body.program.referrals[0].name).not.toBe("Referido propio");
    expect(liveId).not.toBe(fresh.body.id);
  });
});
