import { Router } from "express";

import { templatesController } from "../../modules/templates/templates.controller";

export const templatesRouter = Router();

templatesRouter.get("/templates/presets", templatesController.listPresets);
templatesRouter.get("/templates/current", templatesController.getCurrent);
templatesRouter.get("/templates/:templateId", templatesController.getById);
templatesRouter.post("/templates", templatesController.create);
templatesRouter.patch("/templates/:templateId", templatesController.update);