import { Router } from "express";
import type { ZodType } from "zod";

import { ClinicNotFoundError } from "../../common/errors/membership.errors";
import { BonoValidationError } from "../../common/errors/bono.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import {
  createBonoPlanSchema,
  updateBonoPlanSchema,
  type CreateBonoPlanInput,
  type UpdateBonoPlanInput
} from "../../modules/bonos/bono.schema";
import type { BonoPlanRow } from "../../modules/bonos/bono-plan.service";
import type { MemberBonoRow } from "../../modules/bonos/member-bono.service";

export interface BonosRouterDeps {
  plans: {
    list: (clinicId: string) => Promise<BonoPlanRow[]>;
    create: (clinicId: string, input: CreateBonoPlanInput) => Promise<BonoPlanRow>;
    update: (clinicId: string, id: string, patch: UpdateBonoPlanInput) => Promise<BonoPlanRow>;
    remove: (clinicId: string, id: string) => Promise<{ status: "deleted" | "retired" }>;
  };
  memberBonos: {
    listForMember: (clinicId: string, memberId: string) => Promise<MemberBonoRow[]>;
    cancel: (clinicId: string, memberId: string, bonoId: string) => Promise<MemberBonoRow>;
  };
  /** Resolves a poster slug to a clinic, or throws the 404 the rest of the API uses. */
  findClinic: (slug: string) => Promise<{ id: string }>;
  clinicExists: (clinicId: string) => Promise<boolean>;
}

/** The first problem as the bare Spanish message the editor shows, with no field path. */
const parse = <T>(schema: ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new BonoValidationError(parsed.error.issues[0]?.message ?? "Datos no válidos.");
  }

  return parsed.data;
};

/**
 * A centre's bono plans and the bonos its members hold.
 *
 * Two audiences behind one staff key, like the onboarding router: the admin onboarding view
 * addresses a clinic by id, a centre's own staff by slug. Role checks live in the frontend
 * handlers that call these, as everywhere else.
 */
export const createBonosRouter = (deps: BonosRouterDeps): Router => {
  const router = Router();
  const requireStaff = createRequireStaffKey(config.STAFF_API_KEY);

  /** 404 for a clinic that does not exist, before anything else is said about it. */
  const clinicIdOr404 = async (clinicId: string): Promise<string> => {
    if (!(await deps.clinicExists(clinicId))) throw new ClinicNotFoundError(clinicId);

    return clinicId;
  };

  /* ------------------------------------------------------- admin, during onboarding */

  router.get(
    "/admin/clinics/:clinicId/onboarding/bonos",
    requireStaff,
    asyncHandler(async (req, res) => {
      res.json({ plans: await deps.plans.list(await clinicIdOr404(req.params.clinicId)) });
    })
  );

  router.post(
    "/admin/clinics/:clinicId/onboarding/bonos",
    requireStaff,
    asyncHandler(async (req, res) => {
      const body = parse(createBonoPlanSchema, req.body);

      res.status(201).json(
        await deps.plans.create(await clinicIdOr404(req.params.clinicId), body)
      );
    })
  );

  router.patch(
    "/admin/clinics/:clinicId/onboarding/bonos/:id",
    requireStaff,
    asyncHandler(async (req, res) => {
      const body = parse(updateBonoPlanSchema, req.body);

      res.json(
        await deps.plans.update(await clinicIdOr404(req.params.clinicId), req.params.id, body)
      );
    })
  );

  router.delete(
    "/admin/clinics/:clinicId/onboarding/bonos/:id",
    requireStaff,
    asyncHandler(async (req, res) => {
      res.json(await deps.plans.remove(await clinicIdOr404(req.params.clinicId), req.params.id));
    })
  );

  /* ------------------------------------------------------------------ the centre */

  router.get(
    "/clinics/:slug/bonos",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);

      res.json({ plans: await deps.plans.list(clinic.id) });
    })
  );

  router.post(
    "/clinics/:slug/bonos",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);
      const body = parse(createBonoPlanSchema, req.body);

      res.status(201).json(await deps.plans.create(clinic.id, body));
    })
  );

  router.patch(
    "/clinics/:slug/bonos/:id",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);
      const body = parse(updateBonoPlanSchema, req.body);

      res.json(await deps.plans.update(clinic.id, req.params.id, body));
    })
  );

  router.delete(
    "/clinics/:slug/bonos/:id",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);

      res.json(await deps.plans.remove(clinic.id, req.params.id));
    })
  );

  router.get(
    "/clinics/:slug/members/:memberId/bonos",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);

      res.json({
        bonos: await deps.memberBonos.listForMember(clinic.id, req.params.memberId)
      });
    })
  );

  router.post(
    "/clinics/:slug/members/:memberId/bonos/:bonoId/cancel",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);

      res.json(
        await deps.memberBonos.cancel(clinic.id, req.params.memberId, req.params.bonoId)
      );
    })
  );

  return router;
};
