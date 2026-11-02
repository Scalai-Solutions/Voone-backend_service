import { Router } from "express";
import type { ZodType } from "zod";

import { ChangeRequestValidationError } from "../../common/errors/change-request.errors";
import { ClinicNotFoundError } from "../../common/errors/membership.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createFixedWindowLimiter } from "../../common/middleware/rate-limit";
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
  adminMessageSchema,
  applySchema,
  createChangeRequestSchema,
  messageSchema,
  ownerListQuerySchema,
  previewFlagSchema,
  reopenSchema,
  resolveLinkedSchema,
  strictEmptySchema,
  statusUpdateSchema
} from "../../modules/change-requests/schema";
import type { ChangeFlagService } from "../../modules/change-requests/change-flag.service";
import type { ChangeRequestService } from "../../modules/change-requests/service";

export interface ChangeRequestsRouterDeps {
  service: ChangeRequestService;
  /** The what-if flag: the owner's blurred preview and the admin's exact comparison. */
  flag: ChangeFlagService;
  /** Resolves a clinic slug to its id, or throws the 404 the rest of the API uses. */
  findClinic: (slug: string) => Promise<{ id: string }>;
  clinicExists: (clinicId: string) => Promise<boolean>;
  /** The staff key; defaults to STAFF_API_KEY. Injectable for tests. */
  staffKey?: string;
  /** Whether to refuse everything when no key is set; defaults to NODE_ENV === "production". */
  failClosed?: boolean;
}

/** The first problem as the bare Spanish message the screen shows, with no field path. */
const parseWith =
  (fallback: string) =>
  <T>(schema: ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value ?? {});

    if (!parsed.success) {
      throw new ChangeRequestValidationError(parsed.error.issues[0]?.message ?? fallback);
    }

    return parsed.data;
  };

/** Owner-facing routes answer in Spanish, admin-facing ones in English (the schemas carry the text). */
const parse = parseWith("Datos no válidos.");
const parseAdmin = parseWith("Invalid request.");

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
  const { service, flag } = deps;

  /**
   * The preview runs a five-year simulation per call, so it is capped per clinic: 30 a minute,
   * keyed by the path slug (the staff key is on every call, so there is no staff skip). In memory,
   * per replica: with N replicas the real cap is N times this, and a deploy resets it.
   */
  const previewLimiter = createFixedWindowLimiter({
    limit: 30,
    windowMs: 60_000,
    key: (req) => `flag:${req.params.slug}`
  });

  /* ---- the clinic's side ---- */

  // The owner's what-if for a ticket they have not sent yet. Nothing is stored.
  router.post(
    "/clinics/:slug/change-requests/preview",
    requireStaff,
    // The role first, so a refused caller never spends the clinic's allowance.
    (req, _res, next) => {
      requireClinicReader(req);
      next();
    },
    previewLimiter,
    asyncHandler(async (req, res) => {
      // The clinic is the path's, never the body's (the schema refuses a body that names one).
      const clinic = await deps.findClinic(req.params.slug);
      const body = parse(previewFlagSchema, req.body);

      res.json(await flag.preview(clinic.id, body));
    })
  );

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

      res.json(await service.adminList(parseAdmin(adminListQuerySchema, req.query)));
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
      const query = parseAdmin(adminListQuerySchema, req.query);

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

  // Exact figures for the admin screen only: the clinic's browser never reaches this route.
  router.get(
    "/admin/change-requests/:id/comparison",
    requireStaff,
    asyncHandler(async (req, res) => {
      requireAdminReader(req);

      const { clinicId, ...ticket } = await service.adminFlagSubject(req.params.id);

      res.json(await flag.forTicket(clinicId, ticket));
    })
  );

  router.patch(
    "/admin/change-requests/:id/status",
    requireStaff,
    asyncHandler(async (req, res) => {
      const actor = adminActorOf(req);
      const update = parseAdmin(statusUpdateSchema, req.body);

      res.json(await service.adminSetStatus(req.params.id, actor, update));
    })
  );

  router.post(
    "/admin/change-requests/:id/apply",
    requireStaff,
    asyncHandler(async (req, res) => {
      const actor = adminActorOf(req);
      const { note, categoryId } = parseAdmin(applySchema, req.body);

      res.json(await service.adminApply(req.params.id, actor, { note, categoryId }));
    })
  );

  router.post(
    "/admin/change-requests/:id/draft",
    requireStaff,
    asyncHandler(async (req, res) => {
      adminActorOf(req);
      parseAdmin(strictEmptySchema, req.body);

      res.json(await service.adminDraft(req.params.id));
    })
  );

  // Lives under the programme's own path, which is where the admin is when they publish.
  router.post(
    "/admin/clinics/:clinicId/onboarding/programs/:programId/resolve-tickets",
    requireStaff,
    asyncHandler(async (req, res) => {
      const actor = adminActorOf(req);
      const { note } = parseAdmin(resolveLinkedSchema, req.body);

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
      const { body } = parseAdmin(adminMessageSchema, req.body);

      res.status(201).json(await service.adminReply(req.params.id, actor, body));
    })
  );

  return router;
};
