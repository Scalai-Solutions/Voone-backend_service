import { TemplateStatus } from "@prisma/client";
import type { Clinic, PrismaClient, TemplatePreset, UserRole } from "@prisma/client";

import {
  ClinicCardCreationError,
  ClinicSlugTakenError,
  TemplatePresetNotFoundError
} from "../../common/errors/membership.errors";
import { logger } from "../../common/logger/logger";
import { isUniqueViolation } from "../../common/utils/prisma-errors";
import { generateClinicSlug } from "../../common/utils/short-code";
import { WalletPassEngine } from "../../wallet/engine/wallet-pass.engine";
import { GoogleWalletApiError } from "../../wallet/providers/google/client";
import { buildWalletRegistry } from "../../wallet/wallet.composition";
import {
  templatesRepository,
  treatmentsRepository,
  type WalletClassSyncResult,
  type ClinicTemplateWithRelations
} from "../templates/templates.repository";
import type { ProvisionClinicInput } from "./clinic-provisioning.schema";

/**
 * Google refused to create the card. The clinic exists and its template is PENDING; the
 * next successful template save creates the class and marks it ACTIVE.
 */
export type WalletWarning = "google_pending";

export const WALLET_WARNING_MESSAGES: Record<WalletWarning, string> = {
  google_pending:
    "La tarjeta de Google no se ha podido crear todavía. Se reintentará al guardar el diseño de la tarjeta."
};

export interface ProvisionedClinic {
  clinic: Clinic;
  template: ClinicTemplateWithRelations;
  walletWarning?: WalletWarning;
}

/** What `provisionClinic` needs to undo its own writes, and nothing a caller should see. */
interface CreatedClinic extends ProvisionedClinic {
  /** The owner row as it was before this call touched it; null when this call created it. */
  ownerBefore: { id: string; clinicId: string | null; name: string | null; role: UserRole } | null;
  ownerEmail: string | undefined;
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
 * How many slugs to try before giving up.
 *
 * A five-character slug has 28.6 million possibilities, so a collision is already
 * unlikely; needing five in a row is not a situation a retry can fix, and a loop that
 * never gives up would turn a saturated namespace into a hung onboarding call.
 */
const SLUG_ATTEMPTS = 5;

/**
 * Creates a clinic and its template together, in one transaction.
 *
 * Both or neither: a clinic without a template cannot render its public sign-up page, and
 * half-provisioned rows would leave a slug that 404s with no obvious way to notice.
 */
const createClinicWithTemplate = (
  db: PrismaClient,
  input: ProvisionClinicInput,
  preset: TemplatePreset,
  slug: string
): Promise<CreatedClinic> =>
  db.$transaction(
    async (tx) => {
      const clinic = await tx.clinic.create({
        data: {
          slug,
          name: input.name,
          addressLine: input.addressLine,
          pincode: input.pincode,
          // A new centre is a draft until onboarding finishes and it is activated: no public
          // sign-up page, no notifications (founders' E2E items 15-17).
          isActive: false,
          ...(input.privacyPolicyVersion
            ? { privacyPolicyVersion: input.privacyPolicyVersion }
            : {})
        }
      });

      let ownerBefore: CreatedClinic["ownerBefore"] = null;

      if (input.ownerEmail) {
        const existingOwner = await tx.user.findUnique({ where: { email: input.ownerEmail } });

        ownerBefore = existingOwner
          ? {
              id: existingOwner.id,
              clinicId: existingOwner.clinicId,
              name: existingOwner.name,
              role: existingOwner.role
            }
          : null;

        await tx.user.upsert({
          where: { email: input.ownerEmail },
          update: {
            clinicId: clinic.id,
            name: input.ownerName || null,
            role: "OWNER"
          },
          create: {
            clinicId: clinic.id,
            name: input.ownerName || null,
            email: input.ownerEmail,
            role: "OWNER"
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
          logoOnDarkUrl: input.logoOnDarkUrl,
          heroImageUrl: input.heroImageUrl,
          websiteUrl: input.websiteUrl,
          appointmentUrl: input.appointmentUrl,
          appLinkText: input.appLinkText,
          appLinkDescription: input.appLinkDescription,
          extraButtons: input.extraButtons,
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

      return { clinic, template, ownerBefore, ownerEmail: input.ownerEmail };
    },
    { timeout: 15_000 }
  );

/**
 * Creates the clinic, picking another slug when a generated one is already taken.
 *
 * Checked by catching the unique violation rather than by reading first: two operators
 * onboarding at the same moment would both pass an existence check, and the unique index
 * is what actually settles it.
 *
 * A slug the operator typed is a decision, so a collision is reported to them. A
 * generated one carries no intent, so it is simply replaced — asking an operator to
 * resolve a one-in-28-million coincidence they did not cause would be absurd.
 */
const createWithAvailableSlug = async (
  db: PrismaClient,
  input: ProvisionClinicInput,
  preset: TemplatePreset
): Promise<CreatedClinic> => {
  const chosenByOperator = input.slug !== undefined;
  let slug = input.slug ?? generateClinicSlug();

  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt += 1) {
    try {
      return await createClinicWithTemplate(db, input, preset, slug);
    } catch (error) {
      if (!isUniqueViolation(error, ["slug"])) {
        throw error;
      }

      if (chosenByOperator || attempt === SLUG_ATTEMPTS) {
        throw new ClinicSlugTakenError(slug);
      }

      slug = generateClinicSlug();
    }
  }

  // Unreachable: the final attempt either returns or throws.
  throw new ClinicSlugTakenError(slug);
};

/**
 * Removes what `createClinicWithTemplate` wrote, for a wallet failure that is not Google
 * rejecting the card.
 *
 * Nothing in the schema cascades from Clinic to its template, treatments or wallet class
 * rows, so each is deleted explicitly, children first. An owner account this call created
 * goes too; one that already existed is put back on whatever clinic it belonged to.
 *
 * A Google class that was already created cannot be deleted from here and is left behind.
 * That is harmless: its id derives from this call's new template id, so a retry for another
 * clinic is unaffected and nothing ever points at it.
 */
const rollbackProvisionedClinic = (db: PrismaClient, created: CreatedClinic) =>
  db.$transaction(
    async (tx) => {
      await tx.walletClass.deleteMany({ where: { clinicTemplateId: created.template.id } });
      await tx.clinicTemplate.deleteMany({ where: { id: created.template.id } });
      await tx.clinicTreatment.deleteMany({ where: { clinicId: created.clinic.id } });

      if (created.ownerEmail) {
        if (created.ownerBefore) {
          await tx.user.update({
            where: { id: created.ownerBefore.id },
            data: {
              clinicId: created.ownerBefore.clinicId,
              name: created.ownerBefore.name,
              role: created.ownerBefore.role
            }
          });
        } else {
          // Only a user still attached to the clinic created in THIS call: a concurrent
          // onboarding with the same owner email may have moved it to its own clinic since.
          await tx.user.deleteMany({
            where: { email: created.ownerEmail, clinicId: created.clinic.id }
          });
        }
      }

      await tx.clinic.delete({ where: { id: created.clinic.id } });
    },
    { timeout: 15_000 }
  );

/**
 * Onboards a clinic: the row, its template, and the Wallet class for it.
 *
 * The template is synced to the enabled Wallet providers immediately, so onboarding can
 * finish with the provider class reference already stored.
 *
 * Google refusing the card (`GoogleWalletApiError`) does not undo the clinic: the template
 * stays PENDING, the result carries `walletWarning`, and the next successful template save
 * retries the class. Any other failure removes what this call created and throws a
 * `ClinicCardCreationError`, so the operator is told nothing was kept.
 */
export const provisionClinic = async (
  db: PrismaClient,
  input: ProvisionClinicInput
): Promise<ProvisionedClinic> => {
  const preset = await db.templatePreset.findUnique({ where: { id: input.presetId } });

  if (!preset) {
    throw new TemplatePresetNotFoundError(input.presetId);
  }

  const created = await createWithAvailableSlug(db, input, preset);
  const { clinic, template: createdTemplate } = created;
  let walletWarning: WalletWarning | undefined;

  try {
    const results = await walletEngineFor(db).createClassForTemplate(createdTemplate);

    if (results.length > 0) {
      await markTemplateActive(db, createdTemplate.id, results);
    } else {
      await markTemplateFailed(db, createdTemplate.id);
    }
  } catch (error) {
    if (error instanceof GoogleWalletApiError) {
      // The template is already PENDING from creation, which is the state a retry picks up
      // (markTemplateFailed would make it FAILED, which is not what the operator is told).
      logger.error("Onboarding Google class creation rejected; clinic kept", {
        templateId: createdTemplate.id,
        status: error.status,
        error
      });
      walletWarning = "google_pending";
    } else {
      logger.error("Onboarding wallet class creation failed; removing the clinic", {
        templateId: createdTemplate.id,
        clinicId: clinic.id,
        error
      });

      let rolledBack = true;

      try {
        await rollbackProvisionedClinic(db, created);
      } catch (rollbackError) {
        rolledBack = false;
        logger.error("Onboarding clean-up failed; clinic left behind", {
          clinicId: clinic.id,
          error: rollbackError
        });
      }

      throw new ClinicCardCreationError({ rolledBack, cause: error });
    }
  }

  const template = await db.clinicTemplate.findUnique({
    where: { id: createdTemplate.id },
    include: templateInclude
  });

  return {
    clinic,
    template: template ?? createdTemplate,
    ...(walletWarning ? { walletWarning } : {})
  };
};

/** What an operator needs back: the slug they must print, and what was created. */
export const toProvisionedSummary = ({ clinic, template, walletWarning }: ProvisionedClinic) => ({
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
  },
  ...(walletWarning
    ? { walletWarning, walletWarningMessage: WALLET_WARNING_MESSAGES[walletWarning] }
    : {})
});
