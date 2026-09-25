// Design/QA fixture for the Sapphira Privé pilot card. Keep this route non-production;
// do not change the hardcoded clinic or member names without checking with product first.

import { Router } from "express";

import { getGoogleWalletIssuerId } from "../../wallet/providers/google/client";
import { buildSaveLink, createObject, createOrUpdateClass } from "../../wallet/providers/google";
import type { LoyaltyClassInput, LoyaltyObjectInput } from "../../wallet/providers/google/types";

export const walletTestRouter = Router();

const sapphiraWebsiteUrl = "https://voone.app";
const sapphiraScheduleAppointmentUrl = "https://voone.app/alta/sapphira-prive";
const sapphiraCardBackgroundColor = "#ECCFBF";
const sapphiraLogoUrl =
  process.env.GOOGLE_WALLET_SAPPHIRA_LOGO_URL ??
  "https://i.ibb.co/C5qhWHMk/Whats-App-Image-2026-08-31-at-12-18-49-PM-1.jpg";
const sapphiraHeroImageUrl =
  process.env.GOOGLE_WALLET_SAPPHIRA_HERO_IMAGE_URL ??
  "https://i.ibb.co/GvVfjxJG/Gemini-Generated-Image-897qly897qly897q.png";

function renderAddToWalletPage(saveUrl: string): string {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sapphira Privé | Google Wallet</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f1e8;
        color: #2c2419;
      }

      body {
        display: grid;
        min-height: 100vh;
        margin: 0;
        place-items: center;
      }

      main {
        display: grid;
        gap: 18px;
        justify-items: center;
        padding: 24px;
        text-align: center;
      }

      h1 {
        margin: 0;
        font-size: clamp(24px, 5vw, 38px);
        font-weight: 600;
      }

      p {
        max-width: 520px;
        margin: 0;
        color: #6f6254;
        line-height: 1.5;
      }

      a.wallet-button {
        display: inline-flex;
        min-height: 48px;
        align-items: center;
        border-radius: 999px;
        padding: 8px;
      }

      a.wallet-button:focus-visible {
        outline: 3px solid #1a73e8;
        outline-offset: 4px;
      }

      a.wallet-button img {
        display: block;
        height: 48px;
        width: auto;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Sapphira Privé Membership Club</h1>
      <p>Haz clic en el botón para añadir la tarjeta de prueba a Google Wallet.</p>
      <a class="wallet-button" href="${saveUrl}" rel="noopener noreferrer">
        <img src="/wallet/add-to-google-wallet-es.svg" alt="Añadir a Google Wallet" />
      </a>
    </main>
  </body>
</html>`;
}

walletTestRouter.get("/wallet/test/sapphira-prive/sergio-gil", async (req, res, next) => {
  try {
    const issuerId = getGoogleWalletIssuerId();
    const classId = `${issuerId}.sapphira_prive_member_club`;
    const objectId = `${issuerId}.sapphira_prive_sergio_gil`;

    const classInput: LoyaltyClassInput = {
      classId,
      issuerName: "Sapphira Privé",
      programName: "Sapphira Privé",
      hexBackgroundColor: sapphiraCardBackgroundColor,
      logoUrl: sapphiraLogoUrl,
      heroImageUrl: sapphiraHeroImageUrl,
      heroImageDescription: "Imagen de Sapphira Privé Clinic",
      homepageUrl: sapphiraWebsiteUrl,
      accountNameLabel: "Member",
      accountIdLabel: "Member ID",
      textModules: [
        {
          id: "clinic",
          header: "Clinic",
          body: "Sapphira Privé"
        },
        {
          id: "benefits",
          header: "Benefits",
          body: "10% off facial treatments and birthday surprises."
        },
        {
          id: "info",
          header: "Information",
          body: "This membership card is personal and non-transferable."
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
        displayText: "Schedule Appointment",
        description: "Schedule an appointment",
        url: sapphiraScheduleAppointmentUrl
      }
    };

    const objectInput: LoyaltyObjectInput = {
      objectId,
      classId,
      accountName: "Sergio Gil",
      accountId: "SERGIO-GIL",
      loyaltyPointsLabel: "Beauty Balance",
      loyaltyPointsBalance: 1240,
      tier: "Gold",
      state: "ACTIVE"
    };

    await createOrUpdateClass(classInput);
    await createObject(objectInput);

    const saveUrl = buildSaveLink(objectId);

    if (req.get("accept")?.includes("text/html")) {
      res.type("html").send(renderAddToWalletPage(saveUrl));
      return;
    }

    res.json({ saveUrl });
  } catch (error) {
    next(error);
  }
});
