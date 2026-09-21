import { createHmac } from "node:crypto";

/**
 * The code a member's barcode carries.
 *
 * Three constraints shape this. It must survive every barcode encoding, so it is base32
 * (A-Z and 2-7, no lowercase, no easily-confused 0/1/8). It must not be personal data,
 * so nothing about the member goes into the output. And it must not be guessable from
 * anything a person can see: member ids appear in dashboard URLs, so a plain hash of one
 * would let anyone who has seen a member's page reconstruct their barcode.
 *
 * Hence an HMAC keyed by a server secret rather than a bare digest.
 *
 * Deterministic on purpose: the same member always gets the same code, so a card can be
 * rebuilt without reading a stored value. The cost is that rotating the secret changes
 * every issued barcode at once — which is the argument for eventually storing the code on
 * Member instead. Worth revisiting before the first clinic goes live; until then this
 * keeps the assembler free of a schema change.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, unpadded. Node has no built-in. */
export const toBase32 = (bytes: Buffer): string => {
  let bits = 0;
  let value = 0;
  let encoded = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    encoded += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return encoded;
};

/**
 * 26 characters of base32 is 130 bits of the HMAC — far past guessing, and comfortably
 * inside the 16..64 the card schema allows.
 */
const CODE_LENGTH = 26;

export const deriveRedemptionCode = (memberId: string, secret: string): string =>
  toBase32(createHmac("sha256", secret).update(memberId).digest()).slice(0, CODE_LENGTH);
