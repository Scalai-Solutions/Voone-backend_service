import type { Clinic, ClinicTemplate, PrismaClient } from "@prisma/client";

import { ClinicNotFoundError } from "../../common/errors/membership.errors";
import { clinicSlugSchema } from "../members/membership.schema";

export type ClinicWithTemplate = Clinic & { template: ClinicTemplate | null };

/** Appearance and copy the public sign-up page renders itself with. */
export interface PublicClinicTemplate {
  programName: string;
  hexBackgroundColor: string;
  logoUrl: string | null;
  heroImageUrl: string | null;
  pointsLabel: string;
  tierLabel: string;
  benefitsText: string;
  infoText: string;
}

export interface PublicClinic {
  slug: string;
  name: string;
  privacyPolicyVersion: string;
  template: PublicClinicTemplate;
}

/**
 * Resolves the slug from a QR poster, or throws a 404.
 *
 * A malformed slug, an unseeded slug and an inactive clinic are all the same 404: a slug
 * that fails the format could never have been seeded, and an inactive clinic must not be
 * confirmed to exist. Validating first also keeps junk out of the query entirely.
 *
 * The template is included rather than fetched separately because every caller needs it —
 * the page for its branding, the sign-up for the privacy notice version.
 */
export const findClinicBySlug = async (
  db: PrismaClient,
  slug: string
): Promise<ClinicWithTemplate> => {
  const parsed = clinicSlugSchema.safeParse(slug);

  if (!parsed.success) {
    throw new ClinicNotFoundError(slug);
  }

  const clinic = await db.clinic.findUnique({
    where: { slug: parsed.data },
    include: { template: true }
  });

  if (!clinic || !clinic.isActive) {
    throw new ClinicNotFoundError(slug);
  }

  return clinic;
};

/**
 * Projects field by field rather than spreading, so a column added later — a billing
 * reference, an owner's email — cannot leak into a public response by default.
 *
 * Takes the template separately so the caller has to prove it exists: a clinic with no
 * template cannot render a branded page, and an unbranded one is worse than an honest 404.
 * Template status is deliberately ignored — it tracks wallet provisioning, not whether the
 * clinic may take sign-ups.
 */
export const toPublicClinic = (clinic: Clinic, template: ClinicTemplate): PublicClinic => ({
  slug: clinic.slug,
  name: clinic.name,
  privacyPolicyVersion: clinic.privacyPolicyVersion,
  template: {
    programName: template.programName,
    hexBackgroundColor: template.hexBackgroundColor,
    logoUrl: template.logoUrl,
    heroImageUrl: template.heroImageUrl,
    pointsLabel: template.pointsLabel,
    tierLabel: template.tierLabel,
    benefitsText: template.benefitsText,
    infoText: template.infoText
  }
});
