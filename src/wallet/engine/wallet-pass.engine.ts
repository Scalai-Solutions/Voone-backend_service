import { WalletProviderType } from "@prisma/client";

import { config } from "../../config/env";
import { getGoogleWalletIssuerId } from "../providers/google/client";
import { createOrUpdateClass } from "../providers/google";
import type { LoyaltyClassInput } from "../providers/google/types";
import type {
  ClinicTemplateWithRelations,
  WalletClassSyncResult
} from "../../modules/templates/templates.repository";

export class WalletPassEngine {
  async createClassForTemplate(
    template: ClinicTemplateWithRelations
  ): Promise<WalletClassSyncResult[]> {
    const results: WalletClassSyncResult[] = [];
    const googleClassId = `${getGoogleWalletIssuerId()}.clinic_template_${template.id.replace(/-/g, "_")}`;
    const googleInput: LoyaltyClassInput = {
      issuerName: template.clinic.name,
      classId: googleClassId,
      programName: template.programName,
      hexBackgroundColor: template.hexBackgroundColor,
      logoUrl:
        template.logoUrl ??
        placeholderImageUrl(template.programName, template.hexBackgroundColor, "Logo"),
      // TODO: Confirm recommended hero image dimensions in the current Google Wallet REST docs before replacing this placeholder policy.
      heroImageUrl:
        template.heroImageUrl ??
        placeholderImageUrl(template.programName, template.hexBackgroundColor, "Hero"),
      heroImageDescription: `${template.programName} hero image`,
      homepageUrl: config.FRONTEND_URL,
      accountNameLabel: "Member",
      accountIdLabel: "Member ID",
      rewardsTierLabel: template.tierLabel,
      textModules: [
        {
          id: "clinic",
          header: "Clinic",
          body: template.clinic.name
        },
        {
          id: "benefits",
          header: "Benefits",
          body: template.benefitsText
        },
        {
          id: "info",
          header: "Information",
          body: template.infoText
        }
      ]
    };

    await createOrUpdateClass(googleInput);
    results.push({ provider: WalletProviderType.GOOGLE, externalClassId: googleClassId });

    return results;
  }

  createPass(): never {
    throw new Error("Not implemented");
  }

  updatePass(): never {
    throw new Error("Not implemented");
  }

  deletePass(): never {
    throw new Error("Not implemented");
  }
}

export const walletPassEngine = new WalletPassEngine();

const placeholderImageUrl = (
  programName: string,
  hexBackgroundColor: string,
  label: string
): string => {
  const background = hexBackgroundColor.replace("#", "");
  const text = encodeURIComponent(`${programName} ${label}`);

  return `https://placehold.co/1032x336/${background}/FFFFFF.png?text=${text}`;
};
