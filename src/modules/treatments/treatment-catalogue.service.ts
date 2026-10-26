import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

import {
  TreatmentNotFoundError,
  TreatmentValidationError
} from "../../common/errors/treatment.errors";
import { OWNER_EXTERNAL_ID_PREFIX } from "../onboarding/catalog.repository";
import { CATEGORIES } from "../onboarding/engine.config";
import { POINTS_PER_EURO } from "../onboarding/runtime/points-unit";

/**
 * A centre's treatments as the owner edits them, and as the scan screen and the member
 * directory read them.
 *
 * Two stores exist and a centre uses one of them, decided by ONE rule, `usesCatalogue`: the
 * centre has at least one catalogue row that is not a retail product. The scan screen, the
 * editor's list and every write follow it, so what the scan screen shows is exactly what the
 * editor edits, whatever state the centre's programme is in.
 */

export const PRICE_MESSAGE = "El precio debe estar entre 0,01 € y 100.000 €.";
export const NAME_MESSAGE = "Escribe el nombre del tratamiento.";
export const CATEGORY_MESSAGE = "Elige una categoría de la lista.";
export const DECIMALS_MESSAGE = "Usa como máximo dos decimales.";
export const CATALOGUE_FULL_MESSAGE = "Has alcanzado el máximo de 300 tratamientos.";
export const LAST_TREATMENT_MESSAGE =
  "No puedes borrar el último tratamiento del catálogo. Añade otro primero.";
export const WHOLE_EURO_MESSAGE = "En este centro el precio debe ser un número entero de euros.";

const NAME_MAX = 120;
/** The admin PUT and CSV import cap the catalogue here, so the editor honours the same limit. */
const CATALOGUE_MAX = 300;
/** Retail cosmetics. Engine category of every product; never a treatment. */
const RETAIL_CATEGORY = "COS";
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

const price = z
  .number({ error: PRICE_MESSAGE })
  .refine(
    (value) => Number.isFinite(value) && value >= PRICE_MIN && value <= PRICE_MAX,
    PRICE_MESSAGE
  )
  .refine(
    // At most two decimals, with a tolerance for the float error in value * 100.
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
    DECIMALS_MESSAGE
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

/** `hasOwn`, not `in`: "toString" is not a category. The retail category is not offered. */
const validCategory = (value: string | undefined): value is string =>
  value !== undefined && value !== RETAIL_CATEGORY && Object.hasOwn(CATEGORIES, value);

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
 * Whether this centre's treatments live in the catalogue. The single predicate behind reads
 * and writes. It is the catalogue rows, not the programme's status, that decide: a centre
 * mid-onboarding (rows imported, nothing published) is read from the catalogue, so it is
 * written there too; a live programme with no non-product rows is read from ClinicTreatment,
 * so it is written there.
 */
export const usesCatalogue = async (prisma: PrismaClient, clinicId: string): Promise<boolean> =>
  (await prisma.catalogItem.count({ where: { clinicId, isProduct: false } })) > 0;

/**
 * What the scan screen shows: catalogue rows that are not retail products, else the centre's
 * ClinicTreatment rows. The one query behind the scan screen, the editor and the member
 * directory's spending figures, so they cannot disagree.
 */
const readTreatments = async (
  prisma: PrismaClient,
  clinicId: string,
  catalogue: boolean
): Promise<TreatmentRow[]> => {
  if (catalogue) {
    const catalogItems = await prisma.catalogItem.findMany({
      where: { clinicId, isProduct: false },
      orderBy: [{ position: "asc" }, { externalId: "asc" }],
      select: { id: true, name: true, priceCents: true, categoryId: true }
    });

    return catalogItems.map(catalogRow);
  }

  const treatments = await prisma.clinicTreatment.findMany({
    where: { clinicId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, priceEuro: true, pointsAllotted: true }
  });

  return treatments.map(plainRow);
};

export const listTreatments = async (
  prisma: PrismaClient,
  clinicId: string
): Promise<TreatmentRow[]> =>
  readTreatments(prisma, clinicId, await usesCatalogue(prisma, clinicId));

/**
 * The editor's list together with the rule that produced it: whether the rows are catalogue
 * rows (a category applies, prices may have cents) or a plain centre's (whole euros, no
 * category), so the form can show the right fields instead of learning from a 422.
 */
export const listForEditor = async (
  prisma: PrismaClient,
  clinicId: string
): Promise<{ usesCatalogue: boolean; items: TreatmentRow[] }> => {
  const catalogue = await usesCatalogue(prisma, clinicId);

  return { usesCatalogue: catalogue, items: await readTreatments(prisma, clinicId, catalogue) };
};

/** The scan screen's rows: whole euros and the field names the dashboard already uses. */
export const scanScreenTreatments = async (
  prisma: PrismaClient,
  clinicId: string
): Promise<Array<{ id: string; name: string; priceEuro: number | null; points: number }>> =>
  (await listTreatments(prisma, clinicId)).map((t) => ({
    id: t.id,
    name: t.name,
    priceEuro: t.priceEuro === null ? null : Math.round(t.priceEuro),
    points: t.points
  }));

/** The engine's categories with their Spanish names, for the owner's dropdown. */
export const treatmentCategories = (): Array<{ id: string; label: string }> =>
  Object.entries(CATEGORIES)
    .filter(([id]) => id !== RETAIL_CATEGORY)
    .map(([id, config]) => ({ id, label: config.name }));

export const createTreatment = async (
  prisma: PrismaClient,
  clinicId: string,
  input: CreateTreatmentInput
): Promise<TreatmentRow> => {
  const data = parseInput(createTreatmentSchema, input);

  if (await usesCatalogue(prisma, clinicId)) {
    if (!validCategory(data.categoryId)) throw new TreatmentValidationError(CATEGORY_MESSAGE);

    const rows = await prisma.catalogItem.count({ where: { clinicId } });

    if (rows >= CATALOGUE_MAX) throw new TreatmentValidationError(CATALOGUE_FULL_MESSAGE);

    const last = await prisma.catalogItem.aggregate({
      where: { clinicId },
      _max: { position: true }
    });
    const item = await prisma.catalogItem.create({
      data: {
        clinicId,
        externalId: `${OWNER_EXTERNAL_ID_PREFIX}${randomUUID()}`,
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
 * Finds the row in the store the scan screen is reading for this clinic, scoped to the
 * clinic. A row in the other store is not on screen and is not editable: it is a 404.
 */
const locate = async (prisma: PrismaClient, clinicId: string, id: string) => {
  if (await usesCatalogue(prisma, clinicId)) {
    const item = await prisma.catalogItem.findFirst({
      where: { id, clinicId, isProduct: false },
      select: { id: true }
    });

    if (item) return { store: "catalogue" as const };
  } else {
    const treatment = await prisma.clinicTreatment.findFirst({
      where: { id, clinicId },
      select: { id: true }
    });

    if (treatment) return { store: "plain" as const };
  }

  throw new TreatmentNotFoundError();
};

/**
 * The write statements carry the clinic (and, for the catalogue, `isProduct: false`) in
 * their own WHERE, not only in the lookup before them, so a row of another clinic cannot be
 * touched even if that lookup is ever changed or raced. Prisma reports a miss as P2025.
 */
const scopedOrNotFound = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new TreatmentNotFoundError();
    }

    throw error;
  }
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

    const item = await scopedOrNotFound(() =>
      prisma.catalogItem.update({
        where: { id, clinicId, isProduct: false },
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
      })
    );

    return catalogRow(item);
  }

  if (data.priceEuro !== undefined) requireWholeEuro(data.priceEuro);

  return plainRow(
    await scopedOrNotFound(() =>
      prisma.clinicTreatment.update({
        where: { id, clinicId },
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
    )
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

  if (store === "catalogue") {
    // Deleting the last one would flip the scan screen back to ClinicTreatment rows nobody
    // has maintained since the catalogue took over.
    if ((await prisma.catalogItem.count({ where: { clinicId, isProduct: false } })) <= 1) {
      throw new TreatmentValidationError(LAST_TREATMENT_MESSAGE);
    }

    await scopedOrNotFound(() =>
      prisma.catalogItem.delete({ where: { id, clinicId, isProduct: false } })
    );
  } else {
    await scopedOrNotFound(() => prisma.clinicTreatment.delete({ where: { id, clinicId } }));
  }
};

/** The service as the routes consume it, bound to a database. */
export interface TreatmentCatalogue {
  list: (clinicId: string) => Promise<{ usesCatalogue: boolean; items: TreatmentRow[] }>;
  create: (clinicId: string, input: CreateTreatmentInput) => Promise<TreatmentRow>;
  update: (clinicId: string, id: string, patch: UpdateTreatmentInput) => Promise<TreatmentRow>;
  remove: (clinicId: string, id: string) => Promise<void>;
}

export const createTreatmentCatalogue = (prisma: PrismaClient): TreatmentCatalogue => ({
  list: (clinicId) => listForEditor(prisma, clinicId),
  create: (clinicId, input) => createTreatment(prisma, clinicId, input),
  update: (clinicId, id, patch) => updateTreatment(prisma, clinicId, id, patch),
  remove: (clinicId, id) => removeTreatment(prisma, clinicId, id)
});
