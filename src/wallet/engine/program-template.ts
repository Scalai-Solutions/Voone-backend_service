import { cardButtonSchema } from "./loyalty-card";
import type { ClinicTemplateWithRelations } from "../../modules/templates/templates.repository";
import type { ProgramTemplate } from "./wallet-pass-provider.interface";

/** The part of a clinic template a provider's class is built from. */
export type TemplateForProgram = Pick<
  ClinicTemplateWithRelations,
  | "id"
  | "programName"
  | "hexBackgroundColor"
  | "logoUrl"
  | "logoOnDarkUrl"
  | "heroImageUrl"
  | "websiteUrl"
  | "appointmentUrl"
  | "appLinkText"
  | "appLinkDescription"
  | "pointsLabel"
  | "tierLabel"
  | "benefitsText"
  | "infoText"
> & {
  /** The stored JSON list of further buttons; absent on older fixtures. */
  extraButtons?: unknown;
  /** `onboardingPrograms` is the clinic's live programme, if any: at most one row, id only. */
  clinic: ClinicContact & { name: string; onboardingPrograms?: Array<unknown> };
};

type ClinicContact = { contactPhone?: string | null; contactEmail?: string | null };

/** The stored extra buttons, keeping only the well-formed ones so a bad row cannot break a sync. */
export const extraButtonsOf = (value: unknown) =>
  (Array.isArray(value) ? value : []).flatMap((item) => {
    const parsed = cardButtonSchema.safeParse(item);

    return parsed.success ? [parsed.data] : [];
  });

/**
 * The centre's phone and email as tappable buttons, after its own: every wallet already renders
 * the template's buttons as links, so tel: and mailto: work on both without provider code.
 */
export const contactButtonsOf = (clinic: ClinicContact) => {
  const digits = clinic.contactPhone?.replace(/[^\d+]/g, "");

  return [
    ...(digits ? [{ label: "Llamar al centro", url: `tel:${digits}` }] : []),
    ...(clinic.contactEmail ? [{ label: "Escribir al centro", url: `mailto:${clinic.contactEmail}` }] : [])
  ].filter((button) => cardButtonSchema.safeParse(button).success);
};

/** The clinic's own buttons, then its contact ones. */
export const cardButtonsOf = (extraButtons: unknown, clinic: ClinicContact) => [
  ...extraButtonsOf(extraButtons),
  ...contactButtonsOf(clinic)
];

/** A clinic template as the provider-neutral programme the wallets provision and refresh. */
export const programTemplateFor = (template: TemplateForProgram): ProgramTemplate => ({
  templateId: template.id,
  clinicName: template.clinic.name,
  tierBenefitsFromProgramme: (template.clinic.onboardingPrograms?.length ?? 0) > 0,
  template: {
    programName: template.programName,
    backgroundColor: template.hexBackgroundColor,
    logoUrl: template.logoUrl ?? undefined,
    logoOnDarkUrl: template.logoOnDarkUrl ?? undefined,
    heroImageUrl: template.heroImageUrl ?? undefined,
    websiteUrl: template.websiteUrl ?? undefined,
    appointmentUrl: template.appointmentUrl ?? undefined,
    appLinkText: template.appLinkText ?? undefined,
    appLinkDescription: template.appLinkDescription ?? undefined,
    extraButtons: cardButtonsOf(template.extraButtons, template.clinic),
    pointsLabel: template.pointsLabel,
    tierLabel: template.tierLabel,
    benefitsText: template.benefitsText,
    infoText: template.infoText
  }
});
