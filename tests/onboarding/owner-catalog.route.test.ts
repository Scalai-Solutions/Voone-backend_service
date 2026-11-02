import { PrismaClient, type Clinic } from "@prisma/client";
import express, { type Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ClinicNotFoundError } from "../../src/common/errors/membership.errors";
import { errorHandler } from "../../src/common/middleware/error-handler";
import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";
import type { CatalogItem } from "../../src/modules/onboarding/engine.types";
import { OnboardingService } from "../../src/modules/onboarding/onboarding.service";
import { createOnboardingRouter } from "../../src/routes/v1/onboarding.route";
import catalogFixture from "./reference/sapphira.catalogo.json";

/**
 * The catalogue an owner's app sees: name, price and category, plus whether the row may be a
 * reward, so a picker can offer only what the programme would accept. Never a cost.
 */
const db = new PrismaClient();

const SLUG = "test-owner-catalog";
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

const wipe = async (): Promise<void> => {
  await db.onboardingProgram.deleteMany({ where: { clinicId: clinic.id } });
  await db.catalogItem.deleteMany({ where: { clinicId: clinic.id } });
};

beforeAll(async () => {
  clinic = await db.clinic.upsert({
    where: { slug: SLUG },
    update: {},
    create: { slug: SLUG, name: "Centro catálogo", addressLine: "Calle Seis 6", pincode: "28006" }
  });
  await wipe();
});

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await db.clinic.deleteMany({ where: { slug: SLUG } });
  await db.$disconnect();
});

describe("the owner's catalogue", () => {
  it("marks giftable and still hides costs", async () => {
    // F1 is a facial (a service), M1 is hyaluronic acid (medical, never a reward),
    // K3 is a retail cleanser.
    const wanted = ["F1", "M1", "K3"];
    const put = await call("PUT", `/admin/clinics/${clinic.id}/onboarding/catalog`, {
      items: fixtureItems.filter((i) => wanted.includes(i.externalId))
    });

    expect(put.status).toBe(200);

    const r = await call("GET", `/clinics/${SLUG}/catalog`);

    expect(r.status).toBe(200);

    const byId = new Map<string, any>(r.body.items.map((i: any) => [i.externalId, i])); // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(byId.size).toBe(3);
    expect(byId.get("F1").giftable).toBe(true);
    expect(byId.get("M1").giftable).toBe(false);
    expect(byId.get("K3").giftable).toBe(true);
    expect(byId.get("K3").isProduct).toBe(true);

    const allowed = ["externalId", "name", "priceEuro", "category", "isProduct", "giftable"];

    for (const item of r.body.items) {
      expect(Object.keys(item).sort()).toEqual([...allowed].sort());
    }
  });
});
