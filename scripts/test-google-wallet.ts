import dotenv from "dotenv";

import { GoogleWalletApiError } from "../src/wallet/providers/google/client";
import { buildSaveLink, createObject } from "../src/wallet/providers/google";

dotenv.config();

const issuerId = getRequiredEnv("GOOGLE_WALLET_ISSUER_ID");
process.env.GOOGLE_WALLET_ALLOWED_ORIGIN ??= "http://localhost:3000";

const classId = `${issuerId}.sapphira_sergio_pablo_original`;
const objectId = `${issuerId}.test_member_${Date.now()}`;

const main = async (): Promise<void> => {
  console.log("Creating Google Wallet object", { classId, objectId });

  await createObject({
    objectId,
    classId,
    accountName: "Veronica Navarro",
    accountId: "00000001",
    loyaltyPointsLabel: "Beauty Balance",
    loyaltyPointsBalance: 240,
    tier: "Gold",
    state: "ACTIVE"
  });

  const saveLink = buildSaveLink(objectId);

  console.log("\nObject created successfully.");
  console.log("\nOpen this link on your phone with a registered Wallet tester account:\n");
  console.log(saveLink);
};

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required to run scripts/test-google-wallet.ts`);
  }

  return value;
}

void main().catch((error) => {
  if (error instanceof GoogleWalletApiError && isClassNotApprovedError(error)) {
    console.error("\nGoogle Wallet rejected the object because the class is not approved yet.");
    console.error(`Class ID: ${classId}`);
    console.error(
      "Open this class in Google Wallet Console and submit/publish it for review, then rerun this script."
    );
    process.exitCode = 1;
    return;
  }

  console.error("Google Wallet smoke test failed", {
    message: error instanceof Error ? error.message : String(error)
  });

  process.exitCode = 1;
});

function isClassNotApprovedError(error: GoogleWalletApiError): boolean {
  return JSON.stringify(error.responseBody).includes("not approved");
}
