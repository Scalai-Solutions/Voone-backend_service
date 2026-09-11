import type { Clinic, PrismaClient } from "@prisma/client";

import { ClinicNotFoundError } from "../../common/errors/membership.errors";
import { clinicSlugSchema } from "../members/membership.schema";

/** What the sign-up form needs to render itself. Deliberately not the whole row. */
export interface PublicClinic {
  slug: string;
  name: string;
  tagline: string;
  privacyPolicyVersion: string;
}

/**
 * Resolves the slug from a QR poster, or throws a 404.
 *
 * A malformed slug, an unseeded slug and an inactive clinic are all the same 404: a slug
 * that fails the format could never have been seeded, and an inactive clinic must not be
 * confirmed to exist. Validating first also keeps junk out of the query entirely.
 */
export const findClinicBySlug = async (db: PrismaClient, slug: string): Promise<Clinic> => {
  const parsed = clinicSlugSchema.safeParse(slug);

  if (!parsed.success) {
    throw new ClinicNotFoundError(slug);
  }

  const clinic = await db.clinic.findUnique({ where: { slug: parsed.data } });

  if (!clinic || !clinic.isActive) {
    throw new ClinicNotFoundError(slug);
  }

  return clinic;
};

/**
 * Projects field by field rather than spreading, so a column added later — a billing
 * reference, an owner's email — cannot leak into a public response by default.
 */
export const toPublicClinic = (clinic: Clinic): PublicClinic => ({
  slug: clinic.slug,
  name: clinic.name,
  tagline: clinic.tagline,
  privacyPolicyVersion: clinic.privacyPolicyVersion
});
