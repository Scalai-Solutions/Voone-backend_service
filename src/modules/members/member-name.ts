/** Zero-width and bidirectional formatting characters. See phone-es.ts for why. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;

export const MEMBER_NAME_MIN = 2;

/**
 * Matches LoyaltyCard's member.fullName max. A longer name would pass sign-up and
 * then fail pass issuance for someone who is already in the database.
 */
export const MEMBER_NAME_MAX = 64;

/**
 * A letter or mark, then letters, marks, spaces and the punctuation Spanish, Catalan and
 * Basque names actually use: the apostrophe in O'Donnell, the hyphen in García-López, the
 * middle dot in Marcel·lí, the period in an initial. Digits and symbols are bot noise.
 */
const NAME_SHAPE = /^[\p{L}\p{M}][\p{L}\p{M}\s'’·.-]*$/u;

/**
 * Canonicalizes a submitted name. Pure formatting only — validity is the schema's job.
 *
 * NFC is load-bearing rather than cosmetic: "José" spelled with a combining acute and
 * "José" spelled precomposed are different strings, so without it the same person can
 * hold two spellings and any future lookup by name misses one of them.
 */
export const cleanMemberName = (raw: string): string =>
  raw
    .normalize("NFC")
    // Bidi overrides let a crafted name render deceptively on a pass shown at reception.
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();

/** Whether a cleaned name looks like a name rather than a digit string or an injection. */
export const isPlausibleName = (name: string): boolean =>
  /\p{L}/u.test(name) && NAME_SHAPE.test(name);
