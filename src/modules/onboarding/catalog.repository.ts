import type { CatalogItem as CatalogRow, Prisma, PrismaClient } from "@prisma/client";

import type { CatalogItem, CategoryCode } from "./engine.types";
import { CATEGORIES } from "./engine.config";

/**
 * Reads and writes a centre's catalogue, and converts it to what the engine expects.
 *
 * The conversion is the whole reason this exists. The engine takes prices in euros as
 * plain numbers and leans on item ids for every tie-break, while the database holds cents
 * and its own uuids — so a mistake here does not throw, it quietly produces a different
 * reward ladder.
 */

/**
 * Prefix of the externalId the owner's treatment editor generates. A catalogue replace (the
 * admin CSV import and PUT) leaves these rows alone: the admin's file has never heard of
 * them, and an import must not delete what an owner added from My center.
 */
export const OWNER_EXTERNAL_ID_PREFIX = "owner-";

/** What the caller supplies for one row. Prices arrive in euros, as a person types them. */
export interface CatalogInput {
  /** The centre's own identifier, when it has one. Generated from the position if not. */
  externalId?: string;
  name: string;
  priceEuro: number;
  durationMin?: number | null;
  isProduct?: boolean;
  categoryId?: string | null;
  costPctOverride?: number | null;
  estimated?: boolean;
}

/** Euros to cents, rounded half away from zero so 12.005 does not fall to 12.00. */
const toCents = (euro: number): number => Math.sign(euro) * Math.round(Math.abs(euro) * 100 + 1e-9);

/**
 * Cents back to euros, for the engine.
 *
 * Deterministic: the same integer always yields the same float, so two runs over the same
 * stored catalogue always agree. That is the property the engine needs — not exactness.
 */
const toEuro = (cents: number): number => cents / 100;

/** Only a category the engine knows is honoured; anything else is treated as unset. */
const asCategory = (value: string | null): CategoryCode | undefined =>
  value && value in CATEGORIES ? (value as CategoryCode) : undefined;

/**
 * The engine's view of a stored catalogue.
 *
 * `externalId` becomes the engine's `id`, never the database uuid: the centre's own
 * identifier is the one that survives a re-import, and an id that changes changes the
 * ladder.
 */
export const toEngineCatalog = (rows: CatalogRow[]): CatalogItem[] =>
  rows.map((row) => ({
    id: row.externalId,
    name: row.name,
    price: toEuro(row.priceCents),
    product: row.isProduct,
    cat: asCategory(row.categoryId),
    costPct: row.costPctOverride,
    estimated: row.estimated
  }));

export interface CatalogRepository {
  /** Every row for a clinic, in the stored order the engine must always be given. */
  listForClinic(clinicId: string): Promise<CatalogRow[]>;
  /** Replaces the whole catalogue, preserving each row's identity where it can. */
  replaceForClinic(clinicId: string, items: CatalogInput[]): Promise<CatalogRow[]>;
  /** Corrects one row — a category the centre picked, a price, a cost ratio. */
  updateItem(
    clinicId: string,
    externalId: string,
    patch: Partial<CatalogInput>
  ): Promise<CatalogRow | null>;
}

export class PrismaCatalogRepository implements CatalogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  listForClinic(clinicId: string): Promise<CatalogRow[]> {
    // Ordered by position, then externalId. The second key is not decoration: the engine
    // keeps a bounded beam, so two rows sharing a position could otherwise come back in
    // either order and produce a different ladder on a later run.
    return this.prisma.catalogItem.findMany({
      where: { clinicId },
      orderBy: [{ position: "asc" }, { externalId: "asc" }]
    });
  }

  /**
   * Replaces a clinic's catalogue in one transaction.
   *
   * Upserts by externalId rather than deleting and recreating, which is the mistake
   * ClinicTreatment makes: regenerating ids on every save would change the engine's
   * tie-breaks and so the reward ladder, after an edit that touched nothing relevant.
   * Rows the new catalogue omits are removed, because a catalogue is a complete statement
   * of what the centre sells, except rows an owner added themselves (see
   * OWNER_EXTERNAL_ID_PREFIX).
   */
  async replaceForClinic(clinicId: string, items: CatalogInput[]): Promise<CatalogRow[]> {
    const prepared = items.map((item, index) => ({
      externalId: item.externalId?.trim() || `row-${index + 1}`,
      name: item.name,
      priceCents: toCents(item.priceEuro),
      durationMin: item.durationMin ?? null,
      isProduct: item.isProduct ?? false,
      categoryId: item.categoryId ?? null,
      costPctOverride: item.costPctOverride ?? null,
      estimated: item.estimated ?? false,
      position: index
    }));

    const keep = prepared.map((p) => p.externalId);

    // A generous timeout: this transaction is one upsert per catalogue row, and the database
    // may be a hosted pooler a continent away. At Prisma's 5-second default a large CSV
    // loses the transaction mid-loop and every later upsert answers P2028 ("Transaction
    // not found") against a handle that is already closed.
    await this.prisma.$transaction(
      async (tx) => {
        // An empty list means "the centre sells nothing", which is a legitimate thing to save —
        // deleting the last row in the editor sends exactly that. `notIn: []` is valid and matches
        // every row, so no special case is needed for it.
        await tx.catalogItem.deleteMany({
          where: {
            clinicId,
            externalId: { notIn: keep },
            NOT: { externalId: { startsWith: OWNER_EXTERNAL_ID_PREFIX } }
          }
        });

        for (const row of prepared) {
          await tx.catalogItem.upsert({
            where: { clinicId_externalId: { clinicId, externalId: row.externalId } },
            // Classification is left alone on update: it is recomputed by the engine on
            // every run, and a stored value the centre corrected must not be overwritten
            // by a re-upload that merely changed a price.
            update: {
              name: row.name,
              priceCents: row.priceCents,
              durationMin: row.durationMin,
              isProduct: row.isProduct,
              categoryId: row.categoryId,
              costPctOverride: row.costPctOverride,
              estimated: row.estimated,
              position: row.position
            },
            create: { clinicId, ...row }
          });
        }
      },
      { timeout: 120_000, maxWait: 15_000 }
    );

    return this.listForClinic(clinicId);
  }

  async updateItem(
    clinicId: string,
    externalId: string,
    patch: Partial<CatalogInput>
  ): Promise<CatalogRow | null> {
    const data: Prisma.CatalogItemUpdateInput = {};

    if (patch.name !== undefined) data.name = patch.name;
    if (patch.priceEuro !== undefined) data.priceCents = toCents(patch.priceEuro);
    if (patch.durationMin !== undefined) data.durationMin = patch.durationMin;
    if (patch.isProduct !== undefined) data.isProduct = patch.isProduct;
    if (patch.costPctOverride !== undefined) data.costPctOverride = patch.costPctOverride;
    if (patch.estimated !== undefined) data.estimated = patch.estimated;

    if (patch.categoryId !== undefined) {
      data.categoryId = patch.categoryId;
      // A category the centre picked is an answer to the review prompt, so it clears the
      // flag and records who decided.
      data.classificationSource = patch.categoryId ? "centro" : null;
      data.needsReview = false;
    }

    try {
      return await this.prisma.catalogItem.update({
        where: { clinicId_externalId: { clinicId, externalId } },
        data
      });
    } catch {
      // Prisma throws P2025 when the row is not there. Null rather than an exception,
      // because "no such item" is an ordinary 404 for the route above.
      return null;
    }
  }
}

export { toCents, toEuro };
