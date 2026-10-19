import dotenv from "dotenv";

import { getGoogleWalletIssuerId } from "../src/wallet/providers/google/client";
import { createOrUpdateClass, getLoyaltyClassLinkFields } from "../src/wallet/providers/google";
import type { LoyaltyClassInput } from "../src/wallet/providers/google/types";

dotenv.config();

const sapphiraWebsiteUrl = "https://voone.app";
const sapphiraScheduleAppointmentUrl = "https://voone.app/alta/sapphira-prive";
const sapphiraCardBackgroundColor = "#30221f";
const sapphiraLogoUrl =
  process.env.GOOGLE_WALLET_SAPPHIRA_LOGO_URL ??
  "https://i.ibb.co/C5qhWHMk/Whats-App-Image-2026-08-31-at-12-18-49-PM-1.jpg";
const sapphiraHeroImageUrl =
  process.env.GOOGLE_WALLET_SAPPHIRA_HERO_IMAGE_URL ??
  "https://i.ibb.co/Hfy7XNtb/Gemini-Generated-Image-viollgviollgviol.png";
const expectedDisplayText = "Schedule Appointment";
const expectedLinkCount = 2;

const main = async (): Promise<void> => {
  const issuerId = getGoogleWalletIssuerId();
  const classId = `${issuerId}.sapphira_prive_member_club`;
  const classInput = buildSapphiraClassInput(classId);

  await createOrUpdateClass(classInput);

  const persistedFields = await getLoyaltyClassLinkFields(classId);
  const errors: string[] = [];

  if (persistedFields.appLinkData?.displayText?.defaultValue?.value !== expectedDisplayText) {
    errors.push(
      `Expected appLinkData.displayText.defaultValue.value to be "${expectedDisplayText}"`
    );
  }

  if (persistedFields.linksModuleData?.uris?.length !== expectedLinkCount) {
    errors.push(`Expected linksModuleData.uris length to be ${expectedLinkCount}`);
  }

  if (
    persistedFields.appLinkData?.webAppLinkInfo?.appTarget?.targetUri?.uri !==
    sapphiraScheduleAppointmentUrl
  ) {
    errors.push(
      `Expected appLinkData.webAppLinkInfo.appTarget.targetUri.uri to be "${sapphiraScheduleAppointmentUrl}"`
    );
  }

  if (
    persistedFields.appLinkData?.webAppLinkInfo?.appTarget?.targetUri?.description !==
    "Schedule an appointment"
  ) {
    errors.push(
      'Expected appLinkData.webAppLinkInfo.appTarget.targetUri.description to be "Schedule an appointment"'
    );
  }

  if (errors.length > 0) {
    console.error("Google Wallet LoyaltyClass link verification failed", {
      classId,
      errors,
      appLinkData: persistedFields.appLinkData,
      linksModuleData: persistedFields.linksModuleData
    });
    process.exitCode = 1;
    return;
  }

  console.log("Google Wallet LoyaltyClass link verification passed", {
    classId,
    appLinkDisplayText: persistedFields.appLinkData.displayText.defaultValue.value,
    linksModuleUriCount: persistedFields.linksModuleData.uris.length
  });
};

const buildSapphiraClassInput = (classId: string): LoyaltyClassInput => ({
  classId,
  issuerName: "Sapphira Carranza Privé",
  programName: "Club Diamante",
  hexBackgroundColor: sapphiraCardBackgroundColor,
  logoUrl: sapphiraLogoUrl,
  heroImageUrl: sapphiraHeroImageUrl,
  heroImageDescription: "Imagen de Sapphira Privé Clinic",
  homepageUrl: sapphiraWebsiteUrl,
  accountNameLabel: "Nombre de socia",
  accountIdLabel: "N.º de socia",
  textModules: [
    {
      id: "clinic",
      header: "Centro",
      body: "Sapphira Carranza Privé"
    },
    {
      id: "benefit_cta",
      header: "Beneficio",
      body: "Ver beneficios"
    },
    {
      id: "benefits",
      header: "Beneficios",
      body: "Ventajas exclusivas, prioridad de reserva y sorpresas de cumpleaños."
    },
    {
      id: "info",
      header: "Información",
      body: "Esta tarjeta de fidelización es personal e intransferible."
    }
  ],
  linkModules: [
    {
      tag: "Website",
      description: "Website",
      url: sapphiraWebsiteUrl
    },
    {
      tag: "Schedule Appointment",
      description: "Schedule Appointment",
      url: sapphiraScheduleAppointmentUrl
    }
  ],
  appLink: {
    displayText: expectedDisplayText,
    description: "Schedule an appointment",
    url: sapphiraScheduleAppointmentUrl
  }
});

void main().catch((error) => {
  console.error("Google Wallet LoyaltyClass link verification crashed", {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
