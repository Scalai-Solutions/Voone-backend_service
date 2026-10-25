import { Router } from "express";
import type { ZodType } from "zod";

import { TreatmentValidationError } from "../../common/errors/treatment.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import {
  createTreatmentSchema,
  treatmentCategories,
  updateTreatmentSchema,
  type TreatmentCatalogue
} from "../../modules/treatments/treatment-catalogue.service";

export interface TreatmentsRouterDeps {
  catalogue: TreatmentCatalogue;
  /** Resolves a clinic slug to its id, or throws the 404 the rest of the API uses. */
  findClinic: (slug: string) => Promise<{ id: string }>;
}

/** The first problem as the bare Spanish message the editor shows, with no field path. */
const parse = <T>(schema: ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new TreatmentValidationError(parsed.error.issues[0]?.message ?? "Datos no válidos.");
  }

  return parsed.data;
};

/**
 * What an owner or manager does to their centre's treatments.
 *
 * Behind the staff key like the other `/clinics/:slug` routes: the key proves the request came
 * from the Voone app, and the app checks the `clinicEdit` permission and takes the slug from
 * the session. Every id is resolved inside the clinic the slug names, so another clinic's id
 * is a 404.
 */
export const createTreatmentsRouter = (deps: TreatmentsRouterDeps): Router => {
  const router = Router();
  const requireStaff = createRequireStaffKey(config.STAFF_API_KEY);

  router.get(
    "/clinics/:slug/treatments",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);

      res.json(await deps.catalogue.list(clinic.id));
    })
  );

  // What the owner's category dropdown offers: the engine's own list, so it cannot drift
  // from what create accepts.
  router.get(
    "/clinics/:slug/treatment-categories",
    requireStaff,
    asyncHandler(async (req, res) => {
      await deps.findClinic(req.params.slug);

      res.json(treatmentCategories());
    })
  );

  router.post(
    "/clinics/:slug/treatments",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);
      const body = parse(createTreatmentSchema, req.body);

      res.status(201).json(await deps.catalogue.create(clinic.id, body));
    })
  );

  router.patch(
    "/clinics/:slug/treatments/:id",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);
      const body = parse(updateTreatmentSchema, req.body);

      res.json(await deps.catalogue.update(clinic.id, req.params.id, body));
    })
  );

  router.delete(
    "/clinics/:slug/treatments/:id",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);

      await deps.catalogue.remove(clinic.id, req.params.id);

      res.json({ status: "deleted" });
    })
  );

  return router;
};
