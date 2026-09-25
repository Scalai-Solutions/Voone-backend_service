import { TemplateStatus } from "@prisma/client";
import type { Clinic, PrismaClient } from "@prisma/client";

import {
  ClinicSlugTakenError,
  TemplatePresetNotFoundError
} from "../../common/errors/membership.errors";
import { logger } from "../../common/logger/logger";
import { isUniqueViolation } from "../../common/utils/prisma-errors";
import { WalletPassEngine } from "../../wallet/engine/wallet-pass.engine";
import { buildWalletRegistry } from "../../wallet/wallet.composition";
import { generateTemporaryPassword, hashPassword } from "./onboarding-credentials.service";
import {
  templatesRepository,
  treatmentsRepository,
  type WalletClassSyncResult,
  type ClinicTemplateWithRelations
} from "../templates/templates.repository";
import type { ProvisionClinicInput } from "./clinic-provisioning.schema";

export interface ProvisionedClinic {
  clinic: Clinic;
  template: ClinicTemplateWithRelations;
}

const walletEngineFor = (db: PrismaClient) => new WalletPassEngine(buildWalletRegistry(db));

const templateInclude = {
  clinic: true,
  preset: true,
  walletClasses: true
} as const;

const markTemplateActive = async (
  db: PrismaClient,
  templateId: string,
  results: WalletClassSyncResult[]
) => {
  await db.$transaction([
    ...results.map((result) =>
      db.walletClass.upsert({
        where: {
          clinicTemplateId_provider: {
            clinicTemplateId: templateId,
            provider: result.provider
          }
        },
        update: {
          externalClassId: result.externalClassId,
          status: "SYNCED",
          lastSyncedAt: new Date()
        },
        create: {
          clinicTemplateId: templateId,
          provider: result.provider,
          externalClassId: result.externalClassId,
          status: "SYNCED",
          lastSyncedAt: new Date()
        }
      })
    ),
    db.clinicTemplate.update({
      where: { id: templateId },
      data: { status: TemplateStatus.ACTIVE }
    })
  ]);
};

const markTemplateFailed = (db: PrismaClient, templateId: string) =>
  db.clinicTemplate.update({
    where: { id: templateId },
    data: { status: TemplateStatus.FAILED }
  });

/**
 * Creates a clinic and its template together, in one transaction.
 *
 * Both or neither: a clinic without a template cannot render its public sign-up page, and
 * half-provisioned rows would leave a slug that 404s with no obvious way to notice. The
 * template is also synced to the enabled Wallet providers immediately, so onboarding can
 * finish with the provider class reference already stored.
 */
export const provisionClinic = async (
  db: PrismaClient,
  input: ProvisionClinicInput
): Promise<ProvisionedClinic> => {
  const preset = await db.templatePreset.findUnique({ where: { id: input.presetId } });
  let provisioned: ProvisionedClinic;

  if (!preset) {
    throw new TemplatePresetNotFoundError(input.presetId);
  }

  try {
    provisioned = await db.$transaction(
      async (tx) => {
        const clinic = await tx.clinic.create({
          data: {
            slug: input.slug,
            name: input.name,
            addressLine: input.addressLine,
            pincode: input.pincode,
            ...(input.privacyPolicyVersion
              ? { privacyPolicyVersion: input.privacyPolicyVersion }
              : {})
          }
        });

        if (input.ownerEmail) {
          await tx.user.upsert({
            where: { email: input.ownerEmail },
            update: {
              clinicId: clinic.id,
              name: input.ownerName || null,
              role: "OWNER",
              passwordHash: hashPassword(generateTemporaryPassword()),
              onboardingPasswordGeneratedAt: new Date()
            },
            create: {
              clinicId: clinic.id,
              name: input.ownerName || null,
              email: input.ownerEmail,
              role: "OWNER",
              passwordHash: hashPassword(generateTemporaryPassword()),
              onboardingPasswordGeneratedAt: new Date()
            }
          });
        }

        await treatmentsRepository.replaceForClinic(tx, clinic.id, input.treatments);
        const template = await templatesRepository.create(
          tx,
          clinic.id,
          {
            presetId: preset.id,
            programName: input.programName,
            hexBackgroundColor: input.hexBackgroundColor ?? preset.hexBackgroundColor,
            logoUrl: input.logoUrl,
            heroImageUrl: input.heroImageUrl,
            websiteUrl: input.websiteUrl,
            appointmentUrl: input.appointmentUrl,
            appLinkText: input.appLinkText,
            appLinkDescription: input.appLinkDescription,
            pointsLabel: input.pointsLabel,
            tierLabel: input.tierLabel,
            benefitsText: input.benefitsText,
            infoText: input.infoText,
            tierRewards: input.tierRewards,
            milestoneRewards: input.milestoneRewards,
            treatments: input.treatments
          },
          TemplateStatus.PENDING
        );

        return { clinic, template };
      },
      { timeout: 15_000 }
    );
  } catch (error) {
    // Checked rather than pre-read: two operators submitting the same slug would both pass
    // an existence check, and the unique index is what actually settles it.
    if (isUniqueViolation(error, ["slug"])) {
      throw new ClinicSlugTakenError(input.slug);
    }

    throw error;
  }

  try {
    const results = await walletEngineFor(db).createClassForTemplate(provisioned.template);

    if (results.length > 0) {
      await markTemplateActive(db, provisioned.template.id, results);
    } else {
      await markTemplateFailed(db, provisioned.template.id);
    }
  } catch (error) {
    await markTemplateFailed(db, provisioned.template.id);
    logger.error("Onboarding wallet class creation failed", {
      templateId: provisioned.template.id,
      error
    });
    throw error;
  }

  const template = await db.clinicTemplate.findUnique({
    where: { id: provisioned.template.id },
    include: templateInclude
  });

  return { ...provisioned, template: template ?? provisioned.template };
};

/** What an operator needs back: the slug they must print, and what was created. */
export const toProvisionedSummary = ({ clinic, template }: ProvisionedClinic) => ({
  clinic: {
    id: clinic.id,
    slug: clinic.slug,
    name: clinic.name,
    isActive: clinic.isActive,
    privacyPolicyVersion: clinic.privacyPolicyVersion
  },
  template: {
    id: template.id,
    programName: template.programName,
    hexBackgroundColor: template.hexBackgroundColor,
    status: template.status
  }
});
