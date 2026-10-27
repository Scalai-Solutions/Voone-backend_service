import dotenv from "dotenv";

import {
  getAuthenticatedClient,
  getGoogleWalletIssuerId
} from "../src/wallet/providers/google/client";
import {
  buildClassTemplateInfo,
  createOrUpdateClass,
  PRODUCTION_DETAILS_TEMPLATE_FIELD_PATHS,
  toTemplateItem
} from "../src/wallet/providers/google/classService";
import { addObjectMessage, createObject } from "../src/wallet/providers/google/objectService";
import { buildSaveLink } from "../src/wallet/providers/google/jwt";
import type { LoyaltyClassInput } from "../src/wallet/providers/google/types";

dotenv.config();

// One-off test: does a TEXT_AND_NOTIFY message render on the pass details view when the
// class has NO detailsTemplateOverride (Google's default template)?
// Google API only. Never touches real classes, objects or the database.

const issuerId = getGoogleWalletIssuerId();
const classId = `${issuerId}.tpl_test_default`;
const objectId = `${issuerId}.tpl_test_default_obj`;

const logoUrl =
  process.env.GOOGLE_WALLET_SAPPHIRA_LOGO_URL ??
  "https://i.ibb.co/C5qhWHMk/Whats-App-Image-2026-08-31-at-12-18-49-PM-1.jpg";
const heroImageUrl =
  process.env.GOOGLE_WALLET_SAPPHIRA_HERO_IMAGE_URL ??
  "https://i.ibb.co/Hfy7XNtb/Gemini-Generated-Image-viollgviollgviol.png";

const buildClassInput = (): LoyaltyClassInput => ({
  classId,
  issuerName: "Sapphira Carranza Privé",
  programName: "Club Diamante",
  hexBackgroundColor: "#30221f",
  logoUrl,
  heroImageUrl,
  heroImageDescription: "Imagen de Sapphira Privé Clinic",
  homepageUrl: "https://voone.app",
  accountNameLabel: "Nombre de socia",
  accountIdLabel: "N.º de socia",
  textModules: [
    { id: "clinic", header: "Centro", body: "Sapphira Carranza Privé" },
    { id: "benefit_cta", header: "Beneficio", body: "Ver beneficios" },
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
  ]
});

interface GoogleInterval {
  date?: string;
}

interface GoogleMessageView {
  id?: string;
  header?: string;
  body?: string;
  messageType?: string;
  displayInterval?: {
    start?: GoogleInterval;
    end?: GoogleInterval;
  };
}

const setup = async (): Promise<void> => {
  await createOrUpdateClass(buildClassInput(), { omitDetailsTemplateOverride: true });
  console.log("Class created (no detailsTemplateOverride):", classId);

  await createObject({
    objectId,
    classId,
    accountName: "Test Member",
    accountId: "tpl_test_default_obj",
    memberSince: "2026-10-27",
    loyaltyPointsLabel: "Puntos",
    loyaltyPointsBalance: 0,
    state: "ACTIVE"
  });
  console.log("Object created (ACTIVE):", objectId);

  console.log("Add to Google Wallet save link:");
  console.log(buildSaveLink(objectId));
};

const send = async (): Promise<void> => {
  const sentAt = new Date().toISOString();
  const messageId = await addObjectMessage(objectId, {
    header: "Default template test",
    body: `Default template test sent at ${sentAt}`,
    notify: true
  });
  console.log("Sent TEXT_AND_NOTIFY message:", messageId, "at", sentAt);

  const response = await getAuthenticatedClient().requestWithResponse<{
    messages?: GoogleMessageView[];
  }>(`/loyaltyObject/${encodeURIComponent(objectId)}`);

  if (response.status !== 200) {
    console.error(`GET /loyaltyObject returned ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const serverNow = new Date();
  console.log("Server UTC time:", serverNow.toISOString());

  const messages = response.body.messages ?? [];
  if (messages.length === 0) {
    console.warn("No messages found on the object");
  }

  for (const message of messages) {
    console.log(
      JSON.stringify({
        id: message.id,
        header: message.header,
        messageType: message.messageType,
        displayInterval: message.displayInterval
      })
    );

    const startRaw = message.displayInterval?.start?.date;
    if (startRaw) {
      console.log(`displayInterval.start=${startRaw} (server UTC now: ${serverNow.toISOString()})`);
      if (new Date(startRaw).getTime() > serverNow.getTime()) {
        console.warn("WARNING: displayInterval.start is in the future; message may not render yet");
      }
    }
  }
};

const command = process.argv[2];

interface GoogleClassTemplateInfoView {
  reviewStatus?: string;
  classTemplateInfo?: {
    cardTemplateOverride?: unknown;
    listTemplateOverride?: unknown;
    detailsTemplateOverride?: {
      detailsItemInfos?: Array<{
        item?: { firstValue?: { fields?: Array<{ fieldPath?: string }> } };
      }>;
    };
  };
}

// Guessed override paths for messages: the template docs only describe the DEFAULT
// template (class.messages[ ].header/body, object.messages[ ].header/body) and do not
// state fieldPath values for overrides. If Google rejects these, the PATCH returns 400.
const MESSAGE_FIELD_PATHS = ["class.messages", "object.messages"];

const printDetailsFieldPaths = (view: GoogleClassTemplateInfoView): void => {
  const items = view.classTemplateInfo?.detailsTemplateOverride?.detailsItemInfos ?? [];

  console.log("detailsTemplateOverride.detailsItemInfos fieldPaths:");
  for (const item of items) {
    const fieldPath = item.item?.firstValue?.fields?.[0]?.fieldPath ?? "(missing)";
    const marker = MESSAGE_FIELD_PATHS.includes(fieldPath) ? "  <-- messages item" : "";

    console.log(` - ${fieldPath}${marker}`);
  }
};

const patchOverride = async (): Promise<void> => {
  const client = getAuthenticatedClient();
  const classPath = `/loyaltyClass/${encodeURIComponent(classId)}`;

  // Mirrors createOrUpdateClass / setClassLocations: PATCHing an existing class always
  // sends reviewStatus "UNDER_REVIEW" (issuers cannot write "APPROVED"). Nothing from a
  // GET response is copied into the PATCH body; cardTemplateOverride is rebuilt from the
  // class builder. Arrays are replaced on PATCH, so the full item list is sent.
  const templateInfo = buildClassTemplateInfo();
  const patchBody = {
    reviewStatus: "UNDER_REVIEW",
    classTemplateInfo: {
      cardTemplateOverride: templateInfo.cardTemplateOverride,
      detailsTemplateOverride: {
        detailsItemInfos: [
          ...PRODUCTION_DETAILS_TEMPLATE_FIELD_PATHS.map((fieldPath) => ({
            item: toTemplateItem(fieldPath)
          })),
          ...MESSAGE_FIELD_PATHS.map((fieldPath) => ({
            item: toTemplateItem(fieldPath)
          }))
        ]
      }
    }
  };

  const patch = await client.requestWithResponse<unknown>(classPath, {
    method: "PATCH",
    body: patchBody
  });
  if (patch.status !== 200) {
    console.error(`PATCH /loyaltyClass returned ${patch.status} ${patch.statusText}`);
    process.exit(1);
  }

  const after = await client.requestWithResponse<GoogleClassTemplateInfoView>(classPath);
  if (after.status !== 200) {
    console.error(`GET /loyaltyClass (verify) returned ${after.status} ${after.statusText}`);
    process.exit(1);
  }

  console.log("reviewStatus:", after.body.reviewStatus);
  printDetailsFieldPaths(after.body);
};

const run = async (): Promise<void> => {
  if (command === "setup") return setup();
  if (command === "send") return send();
  if (command === "patch-override") return patchOverride();
  console.error("Usage: tsx scripts/test-default-template.ts <setup|send|patch-override>");
  process.exit(1);
};

void run().catch((error) => {
  console.error("tpl:test failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
