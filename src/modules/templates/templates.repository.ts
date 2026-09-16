import { Prisma, TemplateStatus, WalletProviderType, WalletSyncStatus } from "@prisma/client";

import { prisma } from "../../infrastructure/database/prisma-client";
import type { CreateTemplateInput } from "./templates.schema";

const templateInclude = {
  clinic: true,
  preset: true,
  walletClasses: true
} satisfies Prisma.ClinicTemplateInclude;

export type ClinicTemplateWithRelations = Prisma.ClinicTemplateGetPayload<{ include: typeof templateInclude }>;

export interface WalletClassSyncResult {
  provider: WalletProviderType;
  externalClassId: string;
}

type DatabaseClient = Prisma.TransactionClient | typeof prisma;

const normalizeOptionalUrl = (value: string | undefined): string | null => (value?.trim() ? value.trim() : null);

export const templatesRepository = {
  findPresets() {
    return prisma.templatePreset.findMany({ orderBy: { createdAt: "asc" } });
  },

  findByClinicId(clinicId: string) {
    return prisma.clinicTemplate.findUnique({
      where: { clinicId },
      include: templateInclude
    });
  },

  findById(templateId: string) {
    return prisma.clinicTemplate.findUnique({
      where: { id: templateId },
      include: templateInclude
    });
  },

  create(db: DatabaseClient, clinicId: string, input: CreateTemplateInput, status: TemplateStatus) {
    return db.clinicTemplate.create({
      data: {
        clinicId,
        presetId: input.presetId,
        programName: input.programName,
        hexBackgroundColor: input.hexBackgroundColor,
        logoUrl: normalizeOptionalUrl(input.logoUrl),
        heroImageUrl: normalizeOptionalUrl(input.heroImageUrl),
        pointsLabel: input.pointsLabel,
        tierLabel: input.tierLabel,
        benefitsText: input.benefitsText,
        infoText: input.infoText,
        status
      },
      include: templateInclude
    });
  },

  update(db: DatabaseClient, templateId: string, input: CreateTemplateInput, status?: TemplateStatus) {
    return db.clinicTemplate.update({
      where: { id: templateId },
      data: {
        presetId: input.presetId,
        programName: input.programName,
        hexBackgroundColor: input.hexBackgroundColor,
        logoUrl: normalizeOptionalUrl(input.logoUrl),
        heroImageUrl: normalizeOptionalUrl(input.heroImageUrl),
        pointsLabel: input.pointsLabel,
        tierLabel: input.tierLabel,
        benefitsText: input.benefitsText,
        infoText: input.infoText,
        ...(status ? { status } : {})
      },
      include: templateInclude
    });
  },

  async markActive(templateId: string, results: WalletClassSyncResult[]) {
    await prisma.$transaction([
      ...results.map((result) =>
        prisma.walletClass.upsert({
          where: {
            clinicTemplateId_provider: {
              clinicTemplateId: templateId,
              provider: result.provider
            }
          },
          update: {
            externalClassId: result.externalClassId,
            status: WalletSyncStatus.SYNCED,
            lastSyncedAt: new Date()
          },
          create: {
            clinicTemplateId: templateId,
            provider: result.provider,
            externalClassId: result.externalClassId,
            status: WalletSyncStatus.SYNCED,
            lastSyncedAt: new Date()
          }
        })
      ),
      prisma.clinicTemplate.update({
        where: { id: templateId },
        data: { status: TemplateStatus.ACTIVE }
      })
    ]);
  },

  markFailed(templateId: string) {
    return prisma.clinicTemplate.update({
      where: { id: templateId },
      data: { status: TemplateStatus.FAILED }
    });
  }
};

export const treatmentsRepository = {
  async replaceForClinic(db: DatabaseClient, clinicId: string, treatments: CreateTemplateInput["treatments"]) {
    await db.clinicTreatment.deleteMany({ where: { clinicId } });

    if (treatments.length === 0) {
      return;
    }

    await db.clinicTreatment.createMany({
      data: treatments.map((treatment) => ({
        clinicId,
        name: treatment.name,
        pointsAllotted: treatment.pointsAllotted
      }))
    });
  }
};