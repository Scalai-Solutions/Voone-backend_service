import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import type { AutomationReportService } from "../../modules/notifications/automation-report.service";

export interface AdminNotificationsRouterDeps {
  reports: AutomationReportService;
}

/**
 * Voone's own cross-clinic view of the automated wallet notifications. Same arrangement
 * as the other /admin/* routes: the staff key proves the request came from the Voone
 * app, and the frontend route requires a voone_admin session before calling.
 */
export const createAdminNotificationsRouter = (deps: AdminNotificationsRouterDeps): Router => {
  const router = Router();
  const requireStaff = createRequireStaffKey(config.STAFF_API_KEY);

  router.get(
    "/admin/notifications/overview",
    requireStaff,
    asyncHandler(async (_req, res) => {
      res.json(await deps.reports.automationOverview());
    })
  );

  router.get(
    "/admin/notifications/clinics/:clinicId",
    requireStaff,
    asyncHandler(async (req, res) => {
      const report = await deps.reports.clinicAutomationReport(req.params.clinicId);

      if (!report) {
        res.status(404).json({ code: "CLINIC_NOT_FOUND", message: "Clinic not found" });
        return;
      }

      res.json(report);
    })
  );

  return router;
};
