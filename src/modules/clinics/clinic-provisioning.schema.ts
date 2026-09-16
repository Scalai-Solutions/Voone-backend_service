import { z } from "zod";

import { clinicSlugSchema } from "../members/membership.schema";

/**
 * Defaults for the copy a clinic will refine later. Present so provisioning needs only the
 * facts an operator actually has to hand — a name, an address, a colour — while still
 * producing a template complete enough that /alta/<slug> works immediately.
 */
const DEFAULT_POINTS_LABEL = "Puntos";
const DEFAULT_TIER_LABEL = "Nivel";
const DEFAULT_BENEFITS_TEXT = "Acumula puntos en cada visita y canjéalos por tratamientos.";
const DEFAULT_INFO_TEXT = "Presenta tu pase en recepción para sumar puntos.";

/**
 * Onboards a clinic.
 *
 * Creates the ClinicTemplate alongside the Clinic rather than leaving it for later: a
 * clinic without a template cannot render its public page at all, and the template flow is
 * scoped to a session's own clinic — so with a shared operator account there would be
 * nobody able to create one.
 *
 * hexBackgroundColor is not accepted here. It comes from the chosen preset, which is what a
 * preset is for; letting provisioning set a colour directly would let the two disagree on
 * the first day.
 */
export const provisionClinicSchema = z.object({
  // Written down, never derived from the name: this becomes a URL printed on a physical
  // poster, so renaming the clinic must not invalidate it.
  slug: clinicSlugSchema,

  name: z.string().trim().min(2, "Añade el nombre de la clínica").max(48),
  addressLine: z.string().trim().min(2, "Añade la dirección").max(120),
  pincode: z.string().trim().min(3, "Añade el código postal").max(12),

  presetId: z.string().trim().min(1, "Elige un preset"),
  programName: z.string().trim().min(2, "Añade el nombre del programa").max(120),

  pointsLabel: z.string().trim().min(2).max(80).default(DEFAULT_POINTS_LABEL),
  tierLabel: z.string().trim().min(2).max(80).default(DEFAULT_TIER_LABEL),
  benefitsText: z.string().trim().min(8).max(1200).default(DEFAULT_BENEFITS_TEXT),
  infoText: z.string().trim().min(8).max(1200).default(DEFAULT_INFO_TEXT),

  privacyPolicyVersion: z.string().trim().min(1).max(32).optional()
});

export type ProvisionClinicInput = z.infer<typeof provisionClinicSchema>;
