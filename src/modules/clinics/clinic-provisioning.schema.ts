import { z } from "zod";

import { newClinicSlugSchema } from "../members/membership.schema";
import {
  DEFAULT_WALLET_BENEFITS_TEXT,
  DEFAULT_WALLET_INFO_TEXT,
  DEFAULT_WALLET_POINTS_LABEL,
  DEFAULT_WALLET_TIER_LABEL
} from "../templates/default-voone-template";
import { createTemplateSchema, treatmentInputSchema } from "../templates/templates.schema";

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
  /**
   * Optional, and generated when absent.
   *
   * Never derived from the clinic's name, for two reasons. It becomes a URL printed on a
   * physical poster, so renaming the clinic must not invalidate it — and at five
   * characters a name-derived slug cannot be distinct anyway: half the clinics in Spain
   * would want "clini".
   *
   * An operator may still type one, for a clinic that wants a slug it recognises. A typed
   * slug that is already taken is reported back to them; a generated one is simply
   * regenerated. See provisionClinic.
   */
  slug: newClinicSlugSchema.optional(),

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
  pointsLabel: createTemplateSchema.shape.pointsLabel.default(DEFAULT_WALLET_POINTS_LABEL),
  tierLabel: createTemplateSchema.shape.tierLabel.default(DEFAULT_WALLET_TIER_LABEL),
  benefitsText: createTemplateSchema.shape.benefitsText.default(DEFAULT_WALLET_BENEFITS_TEXT),
  infoText: createTemplateSchema.shape.infoText.default(DEFAULT_WALLET_INFO_TEXT),
  tierRewards: createTemplateSchema.shape.tierRewards,
  milestoneRewards: createTemplateSchema.shape.milestoneRewards,
  treatments: z.array(treatmentInputSchema).max(50).default([]),

  privacyPolicyVersion: z.string().trim().min(1).max(32).optional()
});

export type ProvisionClinicInput = z.infer<typeof provisionClinicSchema>;
