import { createPublicKey, verify } from "node:crypto";

import { z } from "zod";

/**
 * Google Wallet's "pass saved / deleted" callbacks: the signature check.
 *
 * The callback URL is public, so anyone can POST to it; the signature is the only thing that
 * says Google sent it. This is Tink's PaymentMethodTokenRecipient for ECv2SigningOnly, which
 * Google's samples use and Node has no port of:
 *
 * 1. One of Google's root keys (GOOGLE_CALLBACK_KEYS_URL) signed the intermediate key, over
 *    lengthPrefixed(sender, protocol, signedKey).
 * 2. That intermediate key, unexpired, signed the message, over
 *    lengthPrefixed(sender, recipient, protocol, signedMessage).
 * 3. The message itself has not expired.
 *
 * ECDSA P-256 / SHA-256, keys base64 SubjectPublicKeyInfo, signatures base64 DER. The signed
 * strings are used exactly as received: re-serialising them would change the signed bytes.
 * https://developers.google.com/wallet/generic/use-cases/use-callbacks-for-saves-and-deletions
 */

export const GOOGLE_CALLBACK_KEYS_URL = "https://pay.google.com/gp/m/issuer/keys";
const SENDER_ID = "GooglePayPasses";
const PROTOCOL = "ECv2SigningOnly";

export interface GoogleRootKey {
  keyValue: string;
  protocolVersion: string;
  keyExpiration?: string;
}

const callbackBodySchema = z.object({
  protocolVersion: z.literal(PROTOCOL),
  signature: z.string().min(1),
  intermediateSigningKey: z.object({
    signedKey: z.string().min(1),
    signatures: z.array(z.string().min(1)).min(1)
  }),
  signedMessage: z.string().min(1)
});

const signedKeySchema = z.object({
  keyValue: z.string().min(1),
  keyExpiration: z.coerce.number()
});

const messageSchema = z.object({
  classId: z.string().min(1),
  objectId: z.string().min(1),
  eventType: z.enum(["save", "del"]),
  nonce: z.string().min(1),
  expTimeMillis: z.coerce.number()
});

export type GoogleCallbackMessage = z.infer<typeof messageSchema>;

/** Each part as a 4-byte little-endian length followed by its UTF-8 bytes. */
export const lengthPrefixed = (...parts: string[]): Buffer =>
  Buffer.concat(
    parts.flatMap((part) => {
      const bytes = Buffer.from(part, "utf8");
      const length = Buffer.alloc(4);

      length.writeUInt32LE(bytes.length);

      return [length, bytes];
    })
  );

const signedBy = (keyBase64: string, data: Buffer, signatureBase64: string): boolean => {
  try {
    const key = createPublicKey({ key: Buffer.from(keyBase64, "base64"), format: "der", type: "spki" });

    return verify("sha256", data, key, Buffer.from(signatureBase64, "base64"));
  } catch {
    // A malformed key or signature is a failed check, never a 500.
    return false;
  }
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The verified message, or null for anything that is not a genuine, current callback from
 * Google to this issuer. Never throws on bad input.
 */
export const verifyGoogleCallback = (
  body: unknown,
  rootKeys: readonly GoogleRootKey[],
  /** The issuer id: Google signs every callback to it. */
  recipientId: string,
  now: number = Date.now()
): GoogleCallbackMessage | null => {
  const parsed = callbackBodySchema.safeParse(body);

  if (!parsed.success) return null;

  const { signature, intermediateSigningKey, signedMessage } = parsed.data;
  const roots = rootKeys.filter(
    (key) =>
      key.protocolVersion === PROTOCOL &&
      (key.keyExpiration === undefined || Number(key.keyExpiration) > now)
  );
  const keyData = lengthPrefixed(SENDER_ID, PROTOCOL, intermediateSigningKey.signedKey);
  const keySigned = intermediateSigningKey.signatures.some((keySignature) =>
    roots.some((root) => signedBy(root.keyValue, keyData, keySignature))
  );

  if (!keySigned) return null;

  const intermediate = signedKeySchema.safeParse(parseJson(intermediateSigningKey.signedKey));

  if (!intermediate.success || intermediate.data.keyExpiration <= now) return null;

  const messageData = lengthPrefixed(SENDER_ID, recipientId, PROTOCOL, signedMessage);

  if (!signedBy(intermediate.data.keyValue, messageData, signature)) return null;

  const message = messageSchema.safeParse(parseJson(signedMessage));

  if (!message.success || message.data.expTimeMillis <= now) return null;

  return message.data;
};

const KEYS_TTL_MS = 60 * 60 * 1_000;

/**
 * Google's root keys, cached for an hour: they rotate rarely and announce their expiry, and a
 * callback must not wait on a fetch every time. A failed fetch keeps the last good keys.
 */
export const createGoogleRootKeySource = (
  fetchKeys: () => Promise<unknown> = async () =>
    (await fetch(GOOGLE_CALLBACK_KEYS_URL, { signal: AbortSignal.timeout(5_000) })).json(),
  now: () => number = Date.now
) => {
  let cached: { keys: GoogleRootKey[]; at: number } | null = null;
  const keysSchema = z.object({
    keys: z.array(
      z.object({
        keyValue: z.string(),
        protocolVersion: z.string(),
        keyExpiration: z.string().optional()
      })
    )
  });

  return async (): Promise<GoogleRootKey[]> => {
    if (cached && now() - cached.at < KEYS_TTL_MS) return cached.keys;

    try {
      const parsed = keysSchema.parse(await fetchKeys());

      cached = { keys: parsed.keys, at: now() };
    } catch (error) {
      if (!cached) throw error;

      console.warn("[wallet] Google callback keys could not be refreshed; using the cached ones", {
        error: error instanceof Error ? error.name : "unknown"
      });
    }

    return cached.keys;
  };
};
