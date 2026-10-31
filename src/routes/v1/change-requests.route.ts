import { Router } from "express";
import type { ZodType } from "zod";

import { ChangeRequestValidationError } from "../../common/errors/change-request.errors";
import { ClinicNotFoundError } from "../../common/errors/membership.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKeyInProduction } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import {
  adminActorOf,
  clinicActorOf,
  requireAdminReader,
  requireClinicReader
} from "../../modules/change-requests/actor";
import {
  adminListQuerySchema,
  applySchema,
  createChangeRequestSchema,
  messageSchema,
  ownerListQuerySchema,
  reopenSchema,
  resolveLinkedSchema,
  strictEmptySchema,
  statusUpdateSchema
} from "../../modules/change-requests/schema";
import type { ChangeRequestService } from "../../modules/change-requests/service";

export interface ChangeRequestsRouterDeps {
  service: ChangeRequestService;
  /** Resolves a clinic slug to its id, or throws the 404 the rest of the API uses. */
  findClinic: (slug: string) => Promise<{ id: string }>;
  clinicExists: (clinicId: string) => Promise<boolean>;
  /** The staff key; defaults to STAFF_API_KEY. Injectable for tests. */
  staffKey?: string;
  /** Whether to refuse everything when no key is set; defaults to NODE_ENV === "production". */
  failClosed?: boolean;
}

/** The first problem as the bare Spanish message the screen shows, with no field path. */
const parse = <T>(schema: ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value ?? {});

  if (!parsed.success) {
    throw new ChangeRequestValidationError(parsed.error.issues[0]?.message ?? "Datos no válidos.");
  }

  return parsed.data;
};

/**
 * Change requests: a centre asks Voone for what the owner cannot edit directly.
 *
 * Two audiences, both behind the staff key like the other `/clinics/:slug` and `/admin`
 * routes. The clinic side takes the clinic from the slug (the app puts the session's clinic
 * there, never anything from the browser) and requires `x-actor-role` OWNER or MANAGER; every
 * ticket id is resolved inside that clinic, so another clinic's id is a 404. The admin side
 * requires `x-actor-role: voone_admin`. Both read the person from `x-actor`. The roles are
 * headers, only as trustworthy as the staff key, so with no key configured production refuses
 * every request (see createRequireStaffKeyInProduction). See the module README for the shapes.
 */
export const createChangeRequestsRouter = (deps: ChangeRequestsRouterDeps): Router => {
  const router = Router();
  const requireStaff = createRequireStaffKeyInProduction(
    "staffKey" in deps ? deps.staffKey : config.STAFF_API_KEY,
    deps.failClosed ?? process.env.NODE_ENV === "production"
  );
  const { service } = deps;

  /* ---- the clinic's side ---- */

  router.post(
    "/clinics/:slug/change-requests",
    requireStaff,
    asyncHandler(async (req, res) => {
      const actor = clinicActorOf(req);
      const clinic = await deps.findClinic(req.params.slug);
      const input = parse(createChangeRequestSchema, req.body);

      res.status(201).json(await service.create(clinic.id, actor, input));
    })
  );

  router.get(
    "/clinics/:slug/change-requests",
    requireStaff,
    asyncHandler(async (req, res) => {
      requireClinicReader(req);
      const clinic = await deps.findClinic(req.params.slug);
      const query = parse(ownerListQuerySchema, req.query);

      res.json(await service.listForClinic(clinic.id, query));
    })
  );

  router.get(
    "/clinics/:slug/change-requests/:id",
    requireStaff,
    asyncHandler(async (req, res) => {
      requireClinicReader(req);
      const clinic = await deps.findClinic(req.params.slug);

      res.json(await service.getForClinic(clinic.id, req.params.id));
    })
  );

  router.post(
    "/clinics/:slug/change-requests/:id/messages",
    requireStaff,
    asyncHandler(async (req, res) => {
      const actor = clinicActorOf(req);
      const clinic = await deps.findClinic(req.params.slug);
      const { body } = parse(messageSchema, req.body);

      res.status(201).json(await service.replyAsClinic(clinic.id, req.params.id, actor, body));
    })
  );

  router.post(
    "/clinics/:slug/change-requests/:id/reopen",
    requireStaff,
    asyncHandler(async (req, res) => {
      const actor = clinicActorOf(req);
      const clinic = await deps.findClinic(req.params.slug);
      const { message } = parse(reopenSchema, req.body);

      res.json(await service.reopenAsClinic(clinic.id, req.params.id, actor, message));
    })
  );

  /* ---- Voone's side ---- */

  router.get(
    "/admin/change-requests",
    requireStaff,
    asyncHandler(async (req, res) => {
      requireAdminReader(req);

      res.json(await service.adminList(parse(adminListQuerySchema, req.query)));
    })
  );

  router.get(
    "/admin/clinics/:clinicId/change-requests",
    requireStaff,
    asyncHandler(async (req, res) => {
      requireAdminReader(req);

      if (!(await deps.clinicExists(req.params.clinicId))) {
        throw new ClinicNotFoundError(req.params.clinicId);
      }

      // The path decides the clinic; a clinicId in the query string is ignored.
      const query = parse(adminListQuerySchema, req.query);

      res.json(await service.adminList({ ...query, clinicId: req.params.clinicId }));
    })
  );

  router.get(
    "/admin/change-requests/:id",
    requireStaff,
    asyncHandler(async (req, res) => {
      requireAdminReader(req);

      res.json(await service.adminGet(req.params.id));
    })
  );

  router.patch(
    "/admin/change-requests/:id/status",
    requireStaff,
    asyncHandler(async (req, res) => {
      const actor = adminActorOf(req);
      const update = parse(statusUpdateSchema, req.body);

      res.json(await service.adminSetStatus(req.params.id, actor, update));
    })
  );

  router.post(
    "/admin/change-requests/:id/apply",
    requireStaff,
    asyncHandler(async (req, res) => {
      const actor = adminActorOf(req);
      const { note } = parse(applySchema, req.body);

      res.json(await service.adminApply(req.params.id, actor, note));
    })
  );

  router.post(
    "/admin/change-requests/:id/draft",
    requireStaff,
    asyncHandler(async (req, res) => {
      adminActorOf(req);
      parse(strictEmptySchema, req.body);

      res.json(await service.adminDraft(req.params.id));
    })
  );

  // Lives under the programme's own path, which is where the admin is when they publish.
  router.post(
    "/admin/clinics/:clinicId/onboarding/programs/:programId/resolve-tickets",
    requireStaff,
    asyncHandler(async (req, res) => {
      const actor = adminActorOf(req);
      const { note } = parse(resolveLinkedSchema, req.body);

      res.json(
        await service.adminResolveLinked(req.params.clinicId, req.params.programId, actor, note)
      );
    })
  );

  router.post(
    "/admin/change-requests/:id/messages",
    requireStaff,
    asyncHandler(async (req, res) => {
      const actor = adminActorOf(req);
      const { body } = parse(messageSchema, req.body);

      res.status(201).json(await service.adminReply(req.params.id, actor, body));
    })
  );

  return router;
};
