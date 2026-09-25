import { Router } from "express";

import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import { templatesController } from "../../modules/templates/templates.controller";

export const templatesRouter = Router();

/**
 * Writes only. A template decides what a clinic's public sign-up page is called and what
 * colour it is, so an unauthenticated write is a defacement of that page. Reads stay open:
 * the same branding is already public through GET /clinics/:slug, which is the point of it.
 */
const requireStaff = createRequireStaffKey(config.STAFF_API_KEY);

templatesRouter.get("/templates/presets", templatesController.listPresets);
templatesRouter.get("/voone-templates", templatesController.listVoone);
templatesRouter.get("/voone-templates/:templateId", templatesController.getVoone);
templatesRouter.post("/voone-templates", requireStaff, templatesController.createVoone);
templatesRouter.patch(
  "/voone-templates/:templateId",
  requireStaff,
  templatesController.updateVoone
);
templatesRouter.get("/templates/current", templatesController.getCurrent);
templatesRouter.get("/templates", templatesController.list);
templatesRouter.get("/templates/:templateId", templatesController.getById);
templatesRouter.post("/templates", requireStaff, templatesController.create);
templatesRouter.patch("/templates/:templateId", requireStaff, templatesController.update);
