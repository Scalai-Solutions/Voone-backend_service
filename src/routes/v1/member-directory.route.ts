import { Router } from "express";
import { z } from "zod";

import {
  ClinicNotFoundError,
  MembershipValidationError
} from "../../common/errors/membership.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import type { MemberDirectoryService } from "../../modules/members/member-directory.service";

export interface MemberDirectoryRouterDeps {
  directory: MemberDirectoryService;
  /** Resolves a public clinic slug to its id, or null when there is no such clinic. */
  clinicIdForSlug: (slug: string) => Promise<string | null>;
  treatmentsFor: (
    clinicId: string
  ) => Promise<Array<{ id: string; name: string; priceEuro: number | null; points: number }>>;
}

/**
 * `clinicId` is REQUIRED, and that is the important decision here.
 *
 * The dashboard currently calls `/v1/members` with no clinic at all. A backend that
 * obliged by returning every member would show each clinic the others' member lists —
 * names and phone numbers of people attending a named aesthetic clinic. The staff key is
 * a single shared secret and cannot identify a clinic, so the caller has to say, and the
 * frontend already uses `?clinicId=` for `/templates/current`.
 */
const listQuery = z.object({
  clinicId: z.string().min(1, "clinicId is required"),
  q: z.string().trim().min(1).max(100).optional(),
  // Bounded so one request cannot ask for a whole database.
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0)
});

const clinicQuery = z.object({ clinicId: z.string().min(1, "clinicId is required") });

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new MembershipValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }

  return parsed.data;
};

/**
 * The reads the clinic dashboard already makes and the backend has never served.
 *
 * Until now every one of these 404s, and the frontend's withMockFallback quietly
 * substitutes fabricated members and treatments — so the pages look right and show
 * invented people.
 */
export const createMemberDirectoryRouter = (deps: MemberDirectoryRouterDeps): Router => {
  const router = Router();
  const requireStaff = createRequireStaffKey(config.STAFF_API_KEY);

  router.get(
    "/members",
    requireStaff,
    asyncHandler(async (req, res) => {
      const { clinicId, q, limit, offset } = parse(listQuery, req.query);

      res.json(await deps.directory.list({ clinicId, query: q, limit, offset }));
    })
  );

  /**
   * Registered after /members so the literal path is not shadowed, and GET-only: the
   * points routes own POST on this prefix.
   */
  router.get(
    "/members/:memberId",
    requireStaff,
    asyncHandler(async (req, res) => {
      res.json(await deps.directory.get(req.params.memberId));
    })
  );

  /**
   * The same list, scoped by the clinic's public slug.
   *
   * This is the shape the dashboard actually reaches for. Its Next route handler holds
   * the staff key server-side and derives the clinic from the signed-in session, and the
   * session carries the SLUG — so putting the clinic in the path means a caller cannot
   * omit it, and the handler never has to translate. It also matches the existing
   * POST /clinics/:slug/members used by staff entry.
   *
   * The ?clinicId= variant above stays for callers that already hold an id.
   */
  router.get(
    "/clinics/:slug/members",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await deps.clinicIdForSlug(req.params.slug);

      // 404 rather than an empty list: an unknown slug is a different thing from a
      // clinic with no members, and conflating them hides a misconfigured dashboard.
      if (!clinicId) throw new ClinicNotFoundError(req.params.slug);

      const { q, limit, offset } = parse(listQuery.omit({ clinicId: true }), req.query);

      res.json(await deps.directory.list({ clinicId, query: q, limit, offset }));
    })
  );

  router.get(
    "/points/treatments",
    requireStaff,
    asyncHandler(async (req, res) => {
      const { clinicId } = parse(clinicQuery, req.query);

      res.json(await deps.treatmentsFor(clinicId));
    })
  );

  return router;
};
