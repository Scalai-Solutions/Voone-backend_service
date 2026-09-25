import { Prisma, TemplateStatus } from "@prisma/client";

import { ConflictError } from "../../common/errors/conflict-error";
import { logger } from "../../common/logger/logger";
import { prisma } from "../../infrastructure/database/prisma-client";
import { WalletPassEngine } from "../../wallet/engine/wallet-pass.engine";
import { buildWalletRegistry } from "../../wallet/wallet.composition";
import type { CreateTemplateInput, CreateVooneTemplateInput } from "./templates.schema";
import {
  templatesRepository,
  treatmentsRepository,
  vooneTemplatesRepository
} from "./templates.repository";

const walletPassEngine = new WalletPassEngine(buildWalletRegistry(prisma));

const isUniqueClinicTemplateConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002" &&
  Array.isArray(error.meta?.target) &&
  error.meta.target.includes("clinicId");

export const templatesService = {
  listVooneTemplates() {
    return vooneTemplatesRepository.findMany();
  },

  findVooneTemplateById(id: string) {
    return vooneTemplatesRepository.findById(id);
  },

  createVooneTemplate(input: CreateVooneTemplateInput) {
    return vooneTemplatesRepository.create(input);
  },

  updateVooneTemplate(id: string, input: CreateVooneTemplateInput) {
    return vooneTemplatesRepository.update(id, input);
  },

  listPresets() {
    return templatesRepository.findPresets();
  },

  listTemplates() {
    return templatesRepository.findMany();
  },

  findByClinicId(clinicId: string) {
    return templatesRepository.findByClinicId(clinicId);
  },

  findById(templateId: string) {
    return templatesRepository.findById(templateId);
  },

  async createClinicTemplate(clinicId: string, input: CreateTemplateInput) {
    const existing = await templatesRepository.findByClinicId(clinicId);

    if (existing) {
      throw new ConflictError("Clinic already has a template");
    }

    let template;

    try {
      template = await prisma.$transaction(async (tx) => {
        await treatmentsRepository.replaceForClinic(tx, clinicId, input.treatments);
        return templatesRepository.create(tx, clinicId, input, TemplateStatus.PENDING);
      });
    } catch (error) {
      if (isUniqueClinicTemplateConflict(error)) {
        throw new ConflictError("Clinic already has a template");
      }

      throw error;
    }

    try {
      const results = await walletPassEngine.createClassForTemplate(template);

      if (results.length > 0) {
        await templatesRepository.markActive(template.id, results);
      } else {
        await templatesRepository.markFailed(template.id);
      }
    } catch (error) {
      await templatesRepository.markFailed(template.id);
      logger.error("Wallet class creation failed", { templateId: template.id, error });
      throw error;
    }

    return templatesRepository.findById(template.id);
  },

  async updateClinicTemplate(templateId: string, input: CreateTemplateInput) {
    const existing = await templatesRepository.findById(templateId);

    if (!existing) {
      return null;
    }

    const template = await prisma.$transaction(async (tx) => {
      await treatmentsRepository.replaceForClinic(tx, existing.clinicId, input.treatments);
      return templatesRepository.update(tx, templateId, input, TemplateStatus.PENDING);
    });

    try {
      const results = await walletPassEngine.createClassForTemplate(template);

      if (results.length > 0) {
        await templatesRepository.markActive(template.id, results);
      } else {
        await templatesRepository.markFailed(template.id);
      }
    } catch (error) {
      await templatesRepository.markFailed(template.id);
      logger.error("Wallet class update failed", { templateId: template.id, error });
      throw error;
    }

    return templatesRepository.findById(template.id);
  }
};
