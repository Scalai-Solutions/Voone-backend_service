import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { GoogleAuth, type OAuth2Client } from "google-auth-library";

const GOOGLE_WALLET_BASE_URL = "https://walletobjects.googleapis.com/walletobjects/v1";
const GOOGLE_WALLET_SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";

export type GoogleWalletHttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface GoogleWalletRequestOptions {
  method?: GoogleWalletHttpMethod;
  body?: unknown;
  headers?: HeadersInit;
}

export interface GoogleWalletAuthenticatedClient {
  request<TResponse>(path: string, options?: GoogleWalletRequestOptions): Promise<TResponse>;
}

export interface GoogleServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

export class GoogleWalletApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly responseBody?: unknown
  ) {
    super(message);
    this.name = "GoogleWalletApiError";
  }
}

let oauthClientPromise: Promise<OAuth2Client> | null = null;
let authenticatedClient: GoogleWalletAuthenticatedClient | null = null;
let serviceAccountCredentials: GoogleServiceAccountCredentials | null = null;
let serviceAccountCredentialsPromise: Promise<GoogleServiceAccountCredentials> | null = null;

export const getAuthenticatedClient = (): GoogleWalletAuthenticatedClient => {
  if (authenticatedClient) {
    return authenticatedClient;
  }

  authenticatedClient = {
    async request<TResponse>(
      path: string,
      options: GoogleWalletRequestOptions = {}
    ): Promise<TResponse> {
      const accessToken = await getAccessToken();
      const headers = new Headers(options.headers);

      headers.set("Authorization", `Bearer ${accessToken}`);

      if (options.body !== undefined && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }

      try {
        const response = await fetch(`${GOOGLE_WALLET_BASE_URL}${path}`, {
          method: options.method ?? "GET",
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body)
        });

        const responseText = await response.text();
        const responseBody = parseResponseBody(responseText, response.headers.get("content-type"));

        if (!response.ok) {
          console.error("Google Wallet API request failed", {
            status: response.status,
            statusText: response.statusText,
            responseBody
          });

          throw new GoogleWalletApiError(
            `Google Wallet API request failed with ${response.status} ${response.statusText}`,
            response.status,
            response.statusText,
            responseBody
          );
        }

        return responseBody as TResponse;
      } catch (error) {
        if (error instanceof GoogleWalletApiError) {
          throw error;
        }

        console.error("Google Wallet API request could not be completed", {
          message: error instanceof Error ? error.message : String(error)
        });

        throw new GoogleWalletApiError(
          "Google Wallet API request could not be completed",
          0,
          "FETCH_ERROR",
          error instanceof Error ? { message: error.message } : { message: String(error) }
        );
      }
    }
  };

  return authenticatedClient;
};

export const loadServiceAccountCredentials = async (): Promise<GoogleServiceAccountCredentials> => {
  if (serviceAccountCredentials) {
    return serviceAccountCredentials;
  }

  if (!serviceAccountCredentialsPromise) {
    serviceAccountCredentialsPromise = readAndValidateServiceAccountCredentials().then(
      (credentials) => {
        serviceAccountCredentials = credentials;
        return credentials;
      }
    );
  }

  return serviceAccountCredentialsPromise;
};

export const loadServiceAccountCredentialsSync = (): GoogleServiceAccountCredentials => {
  if (serviceAccountCredentials) {
    return serviceAccountCredentials;
  }

  serviceAccountCredentials = readAndValidateServiceAccountCredentialsSync();
  serviceAccountCredentialsPromise = Promise.resolve(serviceAccountCredentials);

  return serviceAccountCredentials;
};

export const getGoogleWalletIssuerId = (): string => getRequiredEnv("GOOGLE_WALLET_ISSUER_ID");

export const getGoogleWalletAllowedOrigin = (): string =>
  getRequiredEnv("GOOGLE_WALLET_ALLOWED_ORIGIN");

export const assertIssuerScopedId = (id: string, fieldName: string): void => {
  const issuerId = getGoogleWalletIssuerId();

  if (!id.startsWith(`${issuerId}.`)) {
    throw new Error(
      `${fieldName} must start with the configured Google Wallet issuer ID (${issuerId}.)`
    );
  }
};

const getAccessToken = async (): Promise<string> => {
  if (!oauthClientPromise) {
    oauthClientPromise = createOAuthClient();
  }

  const oauthClient = await oauthClientPromise;
  const accessTokenResponse = await oauthClient.getAccessToken();
  const accessToken = accessTokenResponse.token;

  if (!accessToken) {
    throw new Error("Google Wallet OAuth client did not return an access token");
  }

  return accessToken;
};

const createOAuthClient = async (): Promise<OAuth2Client> => {
  const serviceAccount = loadServiceAccountCredentialsSync();
  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: [GOOGLE_WALLET_SCOPE]
  });

  return (await auth.getClient()) as OAuth2Client;
};

const readAndValidateServiceAccountCredentials =
  async (): Promise<GoogleServiceAccountCredentials> => {
    const keyFileOrPrivateKey = getRequiredEnv("GOOGLE_WALLET_SERVICE_ACCOUNT_KEY");

    if (!looksLikePrivateKey(keyFileOrPrivateKey)) {
      const rawCredentials = JSON.parse(
        await readFile(keyFileOrPrivateKey, "utf8")
      ) as Partial<GoogleServiceAccountCredentials>;

      return validateServiceAccountCredentials(rawCredentials);
    }

    const rawCredentials = {
      client_email: getRequiredEnv("GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL"),
      private_key: keyFileOrPrivateKey
    };

    return validateServiceAccountCredentials(rawCredentials);
  };

const readAndValidateServiceAccountCredentialsSync = (): GoogleServiceAccountCredentials => {
  const keyFileOrPrivateKey = getRequiredEnv("GOOGLE_WALLET_SERVICE_ACCOUNT_KEY");

  if (!looksLikePrivateKey(keyFileOrPrivateKey)) {
    const rawCredentials = JSON.parse(
      readFileSync(keyFileOrPrivateKey, "utf8")
    ) as Partial<GoogleServiceAccountCredentials>;

    return validateServiceAccountCredentials(rawCredentials);
  }

  const rawCredentials = {
    client_email: getRequiredEnv("GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL"),
    private_key: keyFileOrPrivateKey
  };

  return validateServiceAccountCredentials(rawCredentials);
};

const validateServiceAccountCredentials = (
  rawCredentials: Partial<GoogleServiceAccountCredentials>
): GoogleServiceAccountCredentials => {
  if (!rawCredentials.client_email || !rawCredentials.private_key) {
    throw new Error("Google Wallet service account key must contain client_email and private_key");
  }

  return {
    client_email: rawCredentials.client_email,
    private_key: normalizePrivateKey(rawCredentials.private_key)
  };
};

const looksLikePrivateKey = (value: string): boolean =>
  value.includes("BEGIN PRIVATE KEY") || value.includes("\\n") || !existsSync(value);

const normalizePrivateKey = (privateKey: string): string => {
  const withRealNewlines = privateKey.replace(/\\n/g, "\n").trim();

  if (withRealNewlines.includes("BEGIN PRIVATE KEY")) {
    return withRealNewlines;
  }

  const base64Body = withRealNewlines.replace(/\s/g, "");
  const wrappedBody = base64Body.match(/.{1,64}/g)?.join("\n") ?? base64Body;

  return `-----BEGIN PRIVATE KEY-----\n${wrappedBody}\n-----END PRIVATE KEY-----\n`;
};

const getRequiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required for Google Wallet integration`);
  }

  return value;
};

const parseResponseBody = (responseText: string, contentType: string | null): unknown => {
  if (!responseText) {
    return undefined;
  }

  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(responseText) as unknown;
    } catch {
      return responseText;
    }
  }

  return responseText;
};
