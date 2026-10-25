import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import {
  TreatmentNotFoundError,
  TreatmentValidationError
} from "../../common/errors/treatment.errors";
import { CATEGORIES } from "../onboarding/engine.config";
import { isProgrammeCentre, POINTS_PER_EURO } from "../onboarding/runtime/points-unit";

/**
 * A centre's treatments as the owner edits them, and as the scan screen and the member
 * directory read them.
 *
 * Two stores exist and a centre uses one of them. A centre with a live programme keeps its
 * price list in CatalogItem, which the engine and the scan screen read; any other centre
 * keeps ClinicTreatment. Reading and writing both go through here so a write cannot land in a
 * table the readers ignore.
 */

export const PRICE_MESSAGE = "El precio debe estar entre 0,01 € y 100.000 €.";
export const NAME_MESSAGE = "Escribe el nombre del tratamiento.";
export const CATEGORY_MESSAGE = "Elige una categoría de la lista.";
export const WHOLE_EURO_MESSAGE = "En este centro el precio debe ser un número entero de euros.";

const NAME_MAX = 120;
const PRICE_MIN = 0.01;
const PRICE_MAX = 100_000;

export interface TreatmentRow {
  id: string;
  name: string;
  /**
   * Euros as stored: exact at a programme centre (12.5 stays 12.5, so an editor that sends the
   * price back does not round it), a whole number at others, null for an old row with no price.
   */
  priceEuro: number | null;
  points: number;
  /** An engine category at a programme centre; always null elsewhere. */
  categoryId: string | null;
}

const price = z.number({ error: PRICE_MESSAGE }).refine(
  (value) =>
    Number.isFinite(value) &&
    value >= PRICE_MIN &&
    value <= PRICE_MAX &&
    // At most two decimals, with a tolerance for the float error in value * 100.
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
  PRICE_MESSAGE
);

const name = z
  .string({ error: NAME_MESSAGE })
  .trim()
  .min(1, NAME_MESSAGE)
  .max(NAME_MAX, `El nombre no puede tener más de ${NAME_MAX} caracteres.`);

/** Whether the category is checked is the store's business, so the shape accepts any string. */
const category = z
  .string({ error: CATEGORY_MESSAGE })
  .nullish()
  .transform((value) => value ?? undefined);

/** Owner input. Unknown fields are dropped: the owner never enters a cost. */
export const createTreatmentSchema = z.object({ name, priceEuro: price, categoryId: category });
export const updateTreatmentSchema = z.object({
  name: name.optional(),
  priceEuro: price.optional(),
  categoryId: category
});

export type CreateTreatmentInput = z.input<typeof createTreatmentSchema>;
export type UpdateTreatmentInput = z.input<typeof updateTreatmentSchema>;

/** The first problem, as the bare message: it is Spanish copy, not a field path. */
const parseInput = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new TreatmentValidationError(parsed.error.issues[0]?.message ?? PRICE_MESSAGE);
  }

  return parsed.data;
};

/** `hasOwn`, not `in`: "toString" is not a category. */
const validCategory = (value: string | undefined): value is string =>
  value !== undefined && Object.hasOwn(CATEGORIES, value);

const toCents = (euro: number): number => Math.round(euro * 100);

const catalogRow = (item: {
  id: string;
  name: string;
  priceCents: number;
  categoryId: string | null;
}): TreatmentRow => ({
  id: item.id,
  name: item.name,
  priceEuro: item.priceCents / 100,
  points: Math.max(1, Math.round(item.priceCents / 10)),
  categoryId: item.categoryId
});

const plainRow = (item: {
  id: string;
  name: string;
  priceEuro: number | null;
  pointsAllotted: number;
}): TreatmentRow => ({
  id: item.id,
  name: item.name,
  priceEuro: item.priceEuro,
  // Renamed at the boundary: the dashboard calls it `points`, the schema calls it
  // pointsAllotted. Neither has to move for the other.
  points: item.pointsAllotted,
  categoryId: null
});

const plainPoints = (priceEuro: number): number =>
  Math.max(1, Math.round(priceEuro * POINTS_PER_EURO));

const requireWholeEuro = (priceEuro: number): void => {
  if (!Number.isInteger(priceEuro)) throw new TreatmentValidationError(WHOLE_EURO_MESSAGE);
};

/**
 * What the scan screen shows: catalogue rows that are not retail products, else the centre's
 * ClinicTreatment rows. The one query behind the scan screen, the editor and the member
 * directory's spending figures, so they cannot disagree.
 */
export const listTreatments = async (
  prisma: PrismaClient,
  clinicId: string
): Promise<TreatmentRow[]> => {
  const catalogItems = await prisma.catalogItem.findMany({
    where: { clinicId, isProduct: false },
    orderBy: [{ position: "asc" }, { externalId: "asc" }],
    select: { id: true, name: true, priceCents: true, categoryId: true }
  });

  if (catalogItems.length > 0) return catalogItems.map(catalogRow);

  const treatments = await prisma.clinicTreatment.findMany({
    where: { clinicId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, priceEuro: true, pointsAllotted: true }
  });

  return treatments.map(plainRow);
};

export const createTreatment = async (
  prisma: PrismaClient,
  clinicId: string,
  input: CreateTreatmentInput
): Promise<TreatmentRow> => {
  const data = parseInput(createTreatmentSchema, input);

  if (await isProgrammeCentre(prisma, clinicId)) {
    if (!validCategory(data.categoryId)) throw new TreatmentValidationError(CATEGORY_MESSAGE);

    const last = await prisma.catalogItem.aggregate({
      where: { clinicId },
      _max: { position: true }
    });
    const item = await prisma.catalogItem.create({
      data: {
        clinicId,
        externalId: `owner-${randomUUID()}`,
        name: data.name,
        priceCents: toCents(data.priceEuro),
        isProduct: false,
        categoryId: data.categoryId,
        costPctOverride: null,
        estimated: false,
        needsReview: false,
        classificationSource: "centro",
        position: (last._max.position ?? -1) + 1
      }
    });

    return catalogRow(item);
  }

  requireWholeEuro(data.priceEuro);

  return plainRow(
    await prisma.clinicTreatment.create({
      data: {
        clinicId,
        name: data.name,
        priceEuro: data.priceEuro,
        pointsAllotted: plainPoints(data.priceEuro)
      }
    })
  );
};

/**
 * Finds the row where the readers would show it. Looked up in both stores, scoped to this
 * clinic, so an id GET returned is always found and another clinic's id never is.
 */
const locate = async (prisma: PrismaClient, clinicId: string, id: string) => {
  const item = await prisma.catalogItem.findFirst({
    where: { id, clinicId, isProduct: false },
    select: { id: true }
  });

  if (item) return { store: "catalogue" as const };

  const treatment = await prisma.clinicTreatment.findFirst({
    where: { id, clinicId },
    select: { id: true }
  });

  if (treatment) return { store: "plain" as const };

  throw new TreatmentNotFoundError();
};

export const updateTreatment = async (
  prisma: PrismaClient,
  clinicId: string,
  id: string,
  patch: UpdateTreatmentInput
): Promise<TreatmentRow> => {
  const data = parseInput(updateTreatmentSchema, patch);
  const { store } = await locate(prisma, clinicId, id);

  if (store === "catalogue") {
    if (data.categoryId !== undefined && !validCategory(data.categoryId)) {
      throw new TreatmentValidationError(CATEGORY_MESSAGE);
    }

    const item = await prisma.catalogItem.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        // A price the owner typed is no longer Voone's estimate.
        ...(data.priceEuro !== undefined && {
          priceCents: toCents(data.priceEuro),
          estimated: false
        }),
        ...(data.categoryId !== undefined && {
          categoryId: data.categoryId,
          needsReview: false,
          classificationSource: "centro"
        })
      }
    });

    return catalogRow(item);
  }

  if (data.priceEuro !== undefined) requireWholeEuro(data.priceEuro);

  return plainRow(
    await prisma.clinicTreatment.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        // Points follow the price only when the price changes: an older row may carry a
        // hand-set award that a rename must not rewrite.
        ...(data.priceEuro !== undefined && {
          priceEuro: data.priceEuro,
          pointsAllotted: plainPoints(data.priceEuro)
        })
      }
    })
  );
};

/**
 * Hard delete. Nothing refers to a treatment or catalogue row by id: PaidVisit keeps
 * amounts only, MemberReward keeps rendered text, and a programme version keeps its own
 * catalogue snapshot. Visit history is therefore unaffected.
 */
export const removeTreatment = async (
  prisma: PrismaClient,
  clinicId: string,
  id: string
): Promise<void> => {
  const { store } = await locate(prisma, clinicId, id);

  if (store === "catalogue") await prisma.catalogItem.delete({ where: { id } });
  else await prisma.clinicTreatment.delete({ where: { id } });
};

/** The service as the routes consume it, bound to a database. */
export interface TreatmentCatalogue {
  list: (clinicId: string) => Promise<TreatmentRow[]>;
  create: (clinicId: string, input: CreateTreatmentInput) => Promise<TreatmentRow>;
  update: (clinicId: string, id: string, patch: UpdateTreatmentInput) => Promise<TreatmentRow>;
  remove: (clinicId: string, id: string) => Promise<void>;
}

export const createTreatmentCatalogue = (prisma: PrismaClient): TreatmentCatalogue => ({
  list: (clinicId) => listTreatments(prisma, clinicId),
  create: (clinicId, input) => createTreatment(prisma, clinicId, input),
  update: (clinicId, id, patch) => updateTreatment(prisma, clinicId, id, patch),
  remove: (clinicId, id) => removeTreatment(prisma, clinicId, id)
});
