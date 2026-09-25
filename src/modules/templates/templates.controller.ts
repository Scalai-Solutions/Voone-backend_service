import type { Request, Response } from "express";
import { ZodError } from "zod";

import { ConflictError } from "../../common/errors/conflict-error";
import {
  clinicContextSchema,
  createVooneTemplateSchema,
  createTemplateSchema,
  templateParamsSchema,
  updateTemplateSchema,
  updateVooneTemplateSchema
} from "./templates.schema";
import { templatesService } from "./templates.service";

const getClinicId = (request: Request): string => {
  const headerClinicId = request.header("x-clinic-id");
  const queryClinicId = request.query.clinicId;

  return clinicContextSchema.parse({
    clinicId: headerClinicId ?? (typeof queryClinicId === "string" ? queryClinicId : undefined)
  }).clinicId;
};

const handleControllerError = (error: unknown, res: Response) => {
  if (error instanceof ZodError) {
    res.status(400).json({ message: "Invalid template payload", issues: error.issues });
    return;
  }

  if (error instanceof ConflictError) {
    res.status(409).json({ message: error.message });
    return;
  }

  // Logged, not returned. Echoing error.message here reintroduced inside this module
  // exactly what app-error.ts fixed app-wide: a Prisma failure would ship the datasource
  // URL — password included — to whoever made the request, and a constraint violation
  // would name the constrained columns. Nothing below a deliberate, reviewed error class
  // is safe to hand back.
  console.error(error);
  res.status(500).json({ message: "Internal server error" });
};

export const templatesController = {
  async listVoone(_req: Request, res: Response) {
    try {
      res.json(await templatesService.listVooneTemplates());
    } catch (error) {
      handleControllerError(error, res);
    }
  },

  async getVoone(req: Request, res: Response) {
    try {
      const { templateId } = templateParamsSchema.parse(req.params);
      const template = await templatesService.findVooneTemplateById(templateId);
      if (!template) {
        res.status(404).json({ message: "Voone template not found" });
        return;
      }
      res.json(template);
    } catch (error) {
      handleControllerError(error, res);
    }
  },

  async createVoone(req: Request, res: Response) {
    try {
      res
        .status(201)
        .json(
          await templatesService.createVooneTemplate(createVooneTemplateSchema.parse(req.body))
        );
    } catch (error) {
      handleControllerError(error, res);
    }
  },

  async updateVoone(req: Request, res: Response) {
    try {
      const { templateId } = templateParamsSchema.parse(req.params);
      res.json(
        await templatesService.updateVooneTemplate(
          templateId,
          updateVooneTemplateSchema.parse(req.body)
        )
      );
    } catch (error) {
      handleControllerError(error, res);
    }
  },

  async list(_req: Request, res: Response) {
    try {
      res.json(await templatesService.listTemplates());
    } catch (error) {
      handleControllerError(error, res);
    }
  },

  async listPresets(_req: Request, res: Response) {
    try {
      res.json(await templatesService.listPresets());
    } catch (error) {
      handleControllerError(error, res);
    }
  },

  async getCurrent(req: Request, res: Response) {
    try {
      const clinicId = getClinicId(req);

      res.json(await templatesService.findByClinicId(clinicId));
    } catch (error) {
      handleControllerError(error, res);
    }
  },

  async getById(req: Request, res: Response) {
    try {
      const { templateId } = templateParamsSchema.parse(req.params);
      const template = await templatesService.findById(templateId);

      if (!template) {
        res.status(404).json({ message: "Template not found" });
        return;
      }

      res.json(template);
    } catch (error) {
      handleControllerError(error, res);
    }
  },

  async create(req: Request, res: Response) {
    try {
      const clinicId = getClinicId(req);
      const input = createTemplateSchema.parse(req.body);
      const template = await templatesService.createClinicTemplate(clinicId, input);

      res.status(201).json(template);
    } catch (error) {
      handleControllerError(error, res);
    }
  },

  async update(req: Request, res: Response) {
    try {
      const { templateId } = templateParamsSchema.parse(req.params);
      const input = updateTemplateSchema.parse(req.body);
      const template = await templatesService.updateClinicTemplate(templateId, input);

      if (!template) {
        res.status(404).json({ message: "Template not found" });
        return;
      }

      res.json(template);
    } catch (error) {
      handleControllerError(error, res);
    }
  }
};
