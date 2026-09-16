import type { Clinic, ClinicTemplate, PrismaClient } from "@prisma/client";

import {
  ClinicSlugTakenError,
  TemplatePresetNotFoundError
} from "../../common/errors/membership.errors";
import { isUniqueViolation } from "../../common/utils/prisma-errors";
import type { ProvisionClinicInput } from "./clinic-provisioning.schema";

export interface ProvisionedClinic {
  clinic: Clinic;
  template: ClinicTemplate;
}

/**
 * Creates a clinic and its template together, in one transaction.
 *
 * Both or neither: a clinic without a template cannot render its public sign-up page, and
 * half-provisioned rows would leave a slug that 404s with no obvious way to notice. The
 * colour comes from the preset rather than the caller, so a clinic's page and its future
 * pass cannot disagree on day one.
 */
export const provisionClinic = async (
  db: PrismaClient,
  input: ProvisionClinicInput
): Promise<ProvisionedClinic> => {
  const preset = await db.templatePreset.findUnique({ where: { id: input.presetId } });

  if (!preset) {
    throw new TemplatePresetNotFoundError(input.presetId);
  }

  try {
    return await db.$transaction(async (tx) => {
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

      const template = await tx.clinicTemplate.create({
        data: {
          clinicId: clinic.id,
          presetId: preset.id,
          programName: input.programName,
          // From the preset, deliberately not from the request — see the schema.
          hexBackgroundColor: preset.hexBackgroundColor,
          pointsLabel: input.pointsLabel,
          tierLabel: input.tierLabel,
          benefitsText: input.benefitsText,
          infoText: input.infoText
        }
      });

      return { clinic, template };
    });
  } catch (error) {
    // Checked rather than pre-read: two operators submitting the same slug would both pass
    // an existence check, and the unique index is what actually settles it.
    if (isUniqueViolation(error, ["slug"])) {
      throw new ClinicSlugTakenError(input.slug);
    }

    throw error;
  }
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
