import { ImageStorageError } from "../../common/errors/image.errors";
import { logger } from "../../common/logger/logger";

/** Where uploaded images are kept. A port, so tests and other providers need no network. */
export interface ImageStorage {
  /** Stores `bytes` at `key` and returns the PUBLIC https URL it is served from. */
  put(key: string, bytes: Buffer, contentType: string): Promise<{ url: string }>;
}

export interface BunnyImageStorageOptions {
  /** Regional storage endpoint, no trailing slash: https://storage.bunnycdn.com */
  endpoint: string;
  zone: string;
  /** The storage zone's write password. */
  accessKey: string;
  /** The pull zone's public base URL, no trailing slash. */
  publicBaseUrl: string;
  timeoutMs?: number;
}

const TIMEOUT_MS = 15_000;
/** Enough to diagnose a refusal; Bunny's error bodies are short JSON. */
const LOGGED_BODY_CHARS = 500;

const encodeKey = (key: string): string => key.split("/").map(encodeURIComponent).join("/");

/**
 * Bunny.net Edge Storage: `PUT {endpoint}/{zone}/{path}` with the zone's write password in
 * an `AccessKey` header, answered 201. The file is then public at the linked pull zone.
 *
 * Any failure is one 502 for the caller. The provider's status and body are logged for
 * whoever runs the service; neither they nor the key are ever put in the thrown error.
 */
export class BunnyImageStorage implements ImageStorage {
  constructor(private readonly options: BunnyImageStorageOptions) {}

  async put(key: string, bytes: Buffer, contentType: string): Promise<{ url: string }> {
    const { endpoint, zone, accessKey, publicBaseUrl, timeoutMs = TIMEOUT_MS } = this.options;
    const path = encodeKey(key);

    let response: Response;

    try {
      response = await fetch(`${endpoint}/${zone}/${path}`, {
        method: "PUT",
        headers: { AccessKey: accessKey, "Content-Type": contentType },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      logger.error("[image-storage] Bunny request failed", {
        key,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      });

      throw new ImageStorageError();
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");

      logger.error("[image-storage] Bunny refused the upload", {
        key,
        status: response.status,
        // Redacted in case a proxy or error page echoes the request headers back.
        body: body.replaceAll(accessKey, "[redacted]").slice(0, LOGGED_BODY_CHARS)
      });

      throw new ImageStorageError();
    }

    return { url: `${publicBaseUrl}/${path}` };
  }
}

export interface ImageStorageConfig {
  BUNNY_STORAGE_ZONE?: string | undefined;
  BUNNY_STORAGE_ENDPOINT: string;
  BUNNY_STORAGE_ACCESS_KEY?: string | undefined;
  BUNNY_PUBLIC_BASE_URL?: string | undefined;
}

/**
 * The storage the configuration describes, or null when it is incomplete. Null is a normal
 * state (local development, CI): the upload routes answer 503 and nothing else is affected.
 */
export const buildImageStorage = (cfg: ImageStorageConfig): ImageStorage | null => {
  if (!cfg.BUNNY_STORAGE_ZONE || !cfg.BUNNY_STORAGE_ACCESS_KEY || !cfg.BUNNY_PUBLIC_BASE_URL) {
    return null;
  }

  return new BunnyImageStorage({
    endpoint: cfg.BUNNY_STORAGE_ENDPOINT,
    zone: cfg.BUNNY_STORAGE_ZONE,
    accessKey: cfg.BUNNY_STORAGE_ACCESS_KEY,
    publicBaseUrl: cfg.BUNNY_PUBLIC_BASE_URL
  });
};
