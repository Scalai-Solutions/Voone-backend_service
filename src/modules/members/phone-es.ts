/**
 * Zero-width and bidirectional formatting characters. These arrive constantly from
 * WhatsApp and iOS Contacts pastes and are invisible in every UI, so a length or
 * prefix check that runs before they are stripped silently reads the wrong string.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;

const SPAIN_COUNTRY_CODE = "34";

/** Spanish mobile subscriber numbers are exactly nine digits and start 6 or 7. */
const ES_MOBILE = /^[67][0-9]{8}$/;

/**
 * Stamped onto every stored number. A future change to the rules below must bump this
 * and backfill the rows still carrying the old version, using Member.phoneRaw.
 */
export const NORMALIZER_VERSION = 1;

/**
 * Reduces any way a Spanish mobile can be typed to one E.164 string, or null.
 *
 * Deliberately hand-written rather than delegated to libphonenumber-js: this value sits
 * under a unique constraint, and libphonenumber's metadata changes between releases, so
 * an ordinary dependency bump could silently change what a number normalizes to and split
 * one person into two member rows with no error anywhere.
 *
 * Spain makes that trade cheap — nine-digit subscriber numbers, no variable-length area
 * code, no trunk prefix. Revisit at the second country, together with a backfill.
 */
export const normalizeSpanishMobile = (input: string): string | null => {
  // NFKC first: fullwidth digits from an IME keyboard are non-digits to \D and would be
  // deleted rather than converted, turning a real number into an empty string.
  const cleaned = input.normalize("NFKC").replace(INVISIBLE, "").trim();

  // Read the plus before stripping, because \D removes it along with the separators.
  const hasPlus = cleaned.startsWith("+");
  const digits = cleaned.replace(/\D/g, "");

  let national: string;

  if (hasPlus) {
    // An explicit country code that is not Spain is a foreign number. Reject it rather
    // than reinterpreting its digits as Spanish and storing a number nobody owns.
    if (!digits.startsWith(SPAIN_COUNTRY_CODE)) {
      return null;
    }

    national = digits.slice(2);
  } else if (digits.startsWith(`00${SPAIN_COUNTRY_CODE}`)) {
    national = digits.slice(4);
  } else if (digits.length === 11 && digits.startsWith(SPAIN_COUNTRY_CODE)) {
    // Unambiguous: no Spanish national number is eleven digits, and none starts with 3.
    national = digits.slice(2);
  } else {
    national = digits;
  }

  // 8xx and 9xx are landlines. They are valid numbers belonging to real people, but they
  // cannot receive the SMS the loyalty programme is built on, so accepting one creates a
  // member who can never be reached.
  return ES_MOBILE.test(national) ? `+34${national}` : null;
};
