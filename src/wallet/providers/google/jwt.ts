import jwt from "jsonwebtoken";

import { assertIssuerScopedId, getGoogleWalletAllowedOrigin, loadServiceAccountCredentialsSync } from "./client";

interface SaveToGoogleWalletJwtPayload {
  iss: string;
  aud: "google";
  origins: string[];
  typ: "savetowallet";
  payload: {
    loyaltyObjects: Array<{
      id: string;
    }>;
  };
}

export const buildSaveLink = (objectId: string): string => {
  assertIssuerScopedId(objectId, "objectId");

  const serviceAccountCredentials = loadServiceAccountCredentialsSync();
  const payload: SaveToGoogleWalletJwtPayload = {
    iss: serviceAccountCredentials.client_email,
    aud: "google",
    origins: [getGoogleWalletAllowedOrigin()],
    typ: "savetowallet",
    payload: {
      loyaltyObjects: [
        {
          id: objectId
        }
      ]
    }
  };

  // This is not the OAuth bearer token used for Wallet REST calls. It is a separate Save-to-Wallet JWT, signed directly with the service account private key using RS256.
  const signedJwt = jwt.sign(payload, serviceAccountCredentials.private_key, {
    algorithm: "RS256"
  });

  return `https://pay.google.com/gp/v/save/${signedJwt}`;
};