import { isUniqueViolation } from "../../common/utils/prisma-errors";
import { generateMemberCode } from "../../common/utils/short-code";

/**
 * How many codes to try before giving up.
 *
 * Five characters is 28.6 million per clinic, so a collision is a coincidence rather than
 * a condition. Bounded anyway: one of the two callers sits behind an unauthenticated
 * endpoint, and a loop that never gives up is a way to hold a connection open.
 */
const ATTEMPTS = 5;

/**
 * Runs an insert with a freshly generated member code, retrying if that code is taken.
 *
 * Takes the insert as a closure rather than owning it because the two places a member is
 * created want different rows — the public sign-up form collects consent and demographics,
 * the staff form collects neither — and the only thing they share is this retry.
 *
 * The code is minted here rather than by the caller because it is only meaningful against
 * the unique index: a caller holding a code it generated earlier has no way to know
 * whether it is still free, so the retry has to happen where the insert does.
 *
 * Only a conflict on the code is retried. Any other unique violation — a phone number
 * already registered at this clinic, which is an ordinary re-scan at reception — is left
 * to the caller, which knows what it means.
 */
export const withMemberCode = async <T>(insert: (code: string) => Promise<T>): Promise<T> => {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await insert(generateMemberCode());
    } catch (error) {
      const retryable = isUniqueViolation(error, ["clinicId", "code"]) && attempt < ATTEMPTS;

      if (!retryable) {
        throw error;
      }
    }
  }

  // Unreachable: the final attempt either returns or throws.
  throw new Error("withMemberCode exhausted its attempts without resolving");
};
