import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";

/**
 * An admin re-import replaces the catalogue, but it must not delete what owners added from
 * My center: those rows carry an `owner-` externalId and the admin's file has never heard of
 * them.
 */
const db = new PrismaClient();
const repository = new PrismaCatalogRepository(db);
const SLUG = "tr-import";
let clinicId: string;

const names = async (): Promise<string[]> =>
  (await repository.listForClinic(clinicId)).map((row) => row.externalId).sort();

beforeAll(async () => {
  clinicId = (
    await db.clinic.upsert({
      where: { slug: SLUG },
      update: {},
      create: { slug: SLUG, name: SLUG, addressLine: "Calle Uno 1", pincode: "28001" }
    })
  ).id;
});

beforeEach(async () => {
  await db.catalogItem.deleteMany({ where: { clinicId } });
});

afterAll(async () => {
  await db.catalogItem.deleteMany({ where: { clinicId } });
  await db.clinic.deleteMany({ where: { slug: SLUG } });
  await db.$disconnect();
});

describe("replacing the catalogue", () => {
  it("keeps owner-added rows the import omits, and still removes any other omitted row", async () => {
    await db.catalogItem.createMany({
      data: [
        { clinicId, externalId: "a", name: "A", priceCents: 1000 },
        { clinicId, externalId: "b", name: "B", priceCents: 2000 },
        { clinicId, externalId: "owner-123", name: "Del dueño", priceCents: 3000 }
      ]
    });

    await repository.replaceForClinic(clinicId, [{ externalId: "a", name: "A", priceEuro: 11 }]);

    expect(await names()).toEqual(["a", "owner-123"]);
    expect(
      (await db.catalogItem.findFirstOrThrow({ where: { clinicId, externalId: "owner-123" } }))
        .priceCents
    ).toBe(3000);
  });

  it("still empties a catalogue that has no owner rows", async () => {
    await db.catalogItem.create({ data: { clinicId, externalId: "a", name: "A", priceCents: 1 } });

    await repository.replaceForClinic(clinicId, []);

    expect(await names()).toEqual([]);
  });

  it("only protects the exact prefix", async () => {
    await db.catalogItem.createMany({
      data: [
        { clinicId, externalId: "my-owner-1", name: "X", priceCents: 1 },
        { clinicId, externalId: "owners", name: "Y", priceCents: 1 }
      ]
    });

    await repository.replaceForClinic(clinicId, [{ externalId: "a", name: "A", priceEuro: 1 }]);

    expect(await names()).toEqual(["a"]);
  });
});
