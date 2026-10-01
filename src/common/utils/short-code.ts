import { randomInt } from "node:crypto";

/**
 * Five characters, for identifiers a person has to deal with rather than a machine.
 *
 * Two of them exist: a clinic's public slug, which is printed on a QR poster and typed
 * off it by hand, and a member's code, which is printed on a wallet card and read aloud
 * at reception. Both were previously derived from something long — a clinic name, a UUID
 * — and neither survived contact with a human that way.
 */
export const SHORT_CODE_LENGTH = 5;

/**
 * Characters that cannot be mistaken for one another when read off paper or a phone
 * screen: no i/l/o and no 0/1, in either case.
 *
 * Dropping those five costs almost nothing — 31 characters still gives 28.6 million
 * combinations at length five — and buys the difference between a code that works when
 * someone reads it over the phone and one that does not.
 */
export const CLINIC_SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** The same set, uppercase: a member's code is printed on a card and read aloud. */
export const MEMBER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * A random short code.
 *
 * randomInt rather than `randomBytes % length`: the alphabet is 31 characters, which does
 * not divide 256, so the modulo would make the first few letters measurably likelier than
 * the rest. These codes are not credentials — the barcode is, see redemption-code.ts —
 * but a skewed generator collides sooner than the arithmetic suggests, and collisions are
 * what the retry loops around this exist to absorb.
 */
export const generateShortCode = (alphabet: string, length = SHORT_CODE_LENGTH): string => {
  let code = "";

  for (let index = 0; index < length; index += 1) {
    code += alphabet[randomInt(alphabet.length)];
  }

  return code;
};

/** A slug for a new clinic: lowercase, unambiguous, five characters. */
export const generateClinicSlug = (): string => generateShortCode(CLINIC_SLUG_ALPHABET);

/** A code for a new member, unique within their clinic rather than globally. */
export const generateMemberCode = (): string => generateShortCode(MEMBER_CODE_ALPHABET);
