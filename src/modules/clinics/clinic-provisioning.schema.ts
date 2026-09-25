import { z } from "zod";

import { clinicSlugSchema } from "../members/membership.schema";
import { createTemplateSchema } from "../templates/templates.schema";

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
 * Template fields are accepted here because onboarding may start from a reusable Voone
 * design and then make clinic-specific edits before the first Wallet class is created.
 */
export const provisionClinicSchema = z.object({
  // Written down, never derived from the name: this becomes a URL printed on a physical
  // poster, so renaming the clinic must not invalidate it.
  slug: clinicSlugSchema,

  name: z.string().trim().min(2, "Añade el nombre de la clínica").max(48),
  addressLine: z.string().trim().min(2, "Añade la dirección").max(120),
  pincode: z.string().trim().min(3, "Añade el código postal").max(12),
  ownerName: z.string().trim().min(2).max(120).optional().or(z.literal("")),
  ownerEmail: z.string().trim().toLowerCase().email().max(254).optional().or(z.literal("")),

  presetId: z.string().trim().min(1, "Elige un preset"),
  programName: z.string().trim().min(2, "Añade el nombre del programa").max(120),

  hexBackgroundColor: createTemplateSchema.shape.hexBackgroundColor.optional(),
  logoUrl: createTemplateSchema.shape.logoUrl,
  heroImageUrl: createTemplateSchema.shape.heroImageUrl,
  websiteUrl: createTemplateSchema.shape.websiteUrl,
  appointmentUrl: createTemplateSchema.shape.appointmentUrl,
  appLinkText: createTemplateSchema.shape.appLinkText,
  appLinkDescription: createTemplateSchema.shape.appLinkDescription,
  pointsLabel: z.string().trim().min(2).max(80).default(DEFAULT_POINTS_LABEL),
  tierLabel: z.string().trim().min(2).max(80).default(DEFAULT_TIER_LABEL),
  benefitsText: z.string().trim().min(8).max(1200).default(DEFAULT_BENEFITS_TEXT),
  infoText: z.string().trim().min(8).max(1200).default(DEFAULT_INFO_TEXT),
  tierRewards: createTemplateSchema.shape.tierRewards,
  milestoneRewards: createTemplateSchema.shape.milestoneRewards,
  treatments: createTemplateSchema.shape.treatments.default([
    { name: "Consulta", priceEuro: 0, pointsAllotted: 60 }
  ]),

  privacyPolicyVersion: z.string().trim().min(1).max(32).optional()
});

export type ProvisionClinicInput = z.infer<typeof provisionClinicSchema>;
