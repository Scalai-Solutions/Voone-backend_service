import { Router } from "express";
import { z } from "zod";

import { MembershipValidationError } from "../../common/errors/membership.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import type { DashboardService } from "../../modules/dashboard/dashboard.service";

export interface DashboardRouterDeps {
  dashboard: DashboardService;
}

const clinicQuery = z.object({ clinicId: z.string().min(1, "clinicId is required") });

/**
 * Two audiences behind one staff key, which is worth being explicit about.
 *
 * /dashboard/overview is a CLINIC's own numbers and is scoped by clinicId for the same
 * reason the member list is: the staff key is a single shared secret and cannot identify
 * a clinic, so a caller that does not say would otherwise see someone else's figures.
 *
 * /admin/* is Voone's own view across every clinic. The staff key proves the request came
 * from the Voone app, not that the caller is an administrator — that check lives in the
 * frontend's route handler, which requires a voone_admin session before calling. Same
 * arrangement as the existing /admin/clinics routes.
 */
export const createDashboardRouter = (deps: DashboardRouterDeps): Router => {
  const router = Router();
  const requireStaff = createRequireStaffKey(config.STAFF_API_KEY);

  router.get(
    "/dashboard/overview",
    requireStaff,
    asyncHandler(async (req, res) => {
      const parsed = clinicQuery.safeParse(req.query);

      if (!parsed.success) {
        throw new MembershipValidationError(
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        );
      }

      res.json(await deps.dashboard.clinicOverview(parsed.data.clinicId));
    })
  );

  router.get(
    "/admin/overview",
    requireStaff,
    asyncHandler(async (_req, res) => {
      res.json(await deps.dashboard.platformOverview());
    })
  );

  router.get(
    "/admin/wallet",
    requireStaff,
    asyncHandler(async (_req, res) => {
      res.json(await deps.dashboard.walletInfrastructure());
    })
  );

  return router;
};
