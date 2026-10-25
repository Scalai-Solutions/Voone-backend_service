import { Prisma, TemplateStatus } from "@prisma/client";

import { ConflictError } from "../../common/errors/conflict-error";
import { logger } from "../../common/logger/logger";
import { prisma } from "../../infrastructure/database/prisma-client";
import { refreshClinicCards } from "../wallet-refresh/clinic-card-refresh";
import { WalletPassEngine } from "../../wallet/engine/wallet-pass.engine";
import { buildWalletRegistry } from "../../wallet/wallet.composition";
import type {
  CreateTemplateInput,
  CreateVooneTemplateInput,
  UpdateTemplateInput
} from "./templates.schema";
import { assertOwnsTemplate, diffTemplate, recordTemplateChange } from "./template-change.service";
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

  /** The clinic's own template, as a list so the endpoint keeps its shape. */
  async listTemplates(clinicId: string) {
    const template = await templatesRepository.findByClinicId(clinicId);

    return template ? [template] : [];
  },

  findByClinicId(clinicId: string) {
    return templatesRepository.findByClinicId(clinicId);
  },

  /** Throws TemplateNotFoundError for a missing template and for another clinic's alike. */
  async findOwnedById(templateId: string, clinicId: string) {
    const template = await templatesRepository.findById(templateId);

    assertOwnsTemplate(template, clinicId, templateId);

    return template;
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

  async updateClinicTemplate(
    templateId: string,
    clinicId: string,
    input: UpdateTemplateInput,
    actor?: string
  ) {
    const existing = await templatesRepository.findById(templateId);

    assertOwnsTemplate(existing, clinicId, templateId);

    const changedFields = diffTemplate(existing, input);
    // Read before the transaction opens: it is a count for the record, not part of the write.
    const cardsAtSave =
      changedFields.length > 0
        ? await prisma.member.count({
            where: { clinicId, erasedAt: null, walletObjects: { some: {} } }
          })
        : 0;

    const template = await prisma.$transaction(async (tx) => {
      if (input.treatments) {
        await treatmentsRepository.replaceForClinic(tx, existing.clinicId, input.treatments);
      }

      const updated = await templatesRepository.update(
        tx,
        templateId,
        input,
        TemplateStatus.PENDING
      );

      if (changedFields.length > 0) {
        await recordTemplateChange(tx, {
          clinicId: existing.clinicId,
          templateId,
          actor,
          changedFields,
          cardsAtSave
        });
      }

      return updated;
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

    // Google picks the class change up on its own; Apple passes and Google's per-member text are
    // rebuilt per member. Not awaited: a clinic with thousands of members must not hold the save.
    void refreshClinicCards(existing.clinicId);

    return templatesRepository.findById(template.id);
  }
};
