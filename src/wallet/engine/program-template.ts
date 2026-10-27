import type { ClinicTemplateWithRelations } from "../../modules/templates/templates.repository";
import type { ProgramTemplate } from "./wallet-pass-provider.interface";

/** The part of a clinic template a provider's class is built from. */
export type TemplateForProgram = Pick<
  ClinicTemplateWithRelations,
  | "id"
  | "programName"
  | "hexBackgroundColor"
  | "logoUrl"
  | "heroImageUrl"
  | "websiteUrl"
  | "appointmentUrl"
  | "appLinkText"
  | "appLinkDescription"
  | "pointsLabel"
  | "tierLabel"
  | "benefitsText"
  | "infoText"
> & { clinic: { name: string } };

/** A clinic template as the provider-neutral programme the wallets provision and refresh. */
export const programTemplateFor = (template: TemplateForProgram): ProgramTemplate => ({
  templateId: template.id,
  clinicName: template.clinic.name,
  template: {
    programName: template.programName,
    backgroundColor: template.hexBackgroundColor,
    logoUrl: template.logoUrl ?? undefined,
    heroImageUrl: template.heroImageUrl ?? undefined,
    websiteUrl: template.websiteUrl ?? undefined,
    appointmentUrl: template.appointmentUrl ?? undefined,
    appLinkText: template.appLinkText ?? undefined,
    appLinkDescription: template.appLinkDescription ?? undefined,
    pointsLabel: template.pointsLabel,
    tierLabel: template.tierLabel,
    benefitsText: template.benefitsText,
    infoText: template.infoText
  }
});
