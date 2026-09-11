import type { Clinic, PrismaClient } from "@prisma/client";

import { isUniqueViolation } from "../../common/utils/prisma-errors";
import { madridYear } from "./member-since";
import type { MembershipSignupInput } from "./membership.schema";
import { NORMALIZER_VERSION } from "./phone-es";

export interface SignUpResult {
  /** False when the number was already a member. Not exposed — see the route. */
  created: boolean;
}

/**
 * Registers a member of a clinic, idempotently.
 *
 * Inserts first and recovers from the conflict, rather than reading then writing. A
 * read-then-write is a time-of-check race: two reception-desk taps 40ms apart both see
 * "not found" and both insert. The unique index is the synchronization primitive here,
 * so no transaction is needed.
 */
export const signUpMember = async (
  db: PrismaClient,
  clinic: Clinic,
  input: MembershipSignupInput,
  now: Date = new Date()
): Promise<SignUpResult> => {
  try {
    await db.member.create({
      data: {
        clinicId: clinic.id,
        fullName: input.fullName,
        phone: input.phone,
        phoneRaw: input.phoneRaw,
        phoneRegionAssumed: input.phoneRegionAssumed,
        normalizerVersion: NORMALIZER_VERSION,
        memberSince: madridYear(now),
        consentMarketing: input.consentMarketing,
        consentMarketingAt: input.consentMarketing ? now : null,
        // Snapshot, not a reference: the evidence is which notice the member was shown,
        // and a foreign key to an editable row would destroy it.
        privacyPolicyVersion: clinic.privacyPolicyVersion,
        lastSignupAt: now
      }
    });

    return { created: true };
  } catch (error) {
    if (!isUniqueViolation(error, ["clinicId", "phone"])) {
      throw error;
    }

    try {
      // Addressed by the composite unique key directly, so this is one round trip and
      // cannot race with itself. Only the counters move: rewriting fullName here would
      // let anyone who knows a phone number rename a real member, and that name is what
      // appears on the pass they show at reception.
      await db.member.update({
        where: { clinicId_phone: { clinicId: clinic.id, phone: input.phone } },
        data: { signupCount: { increment: 1 }, lastSignupAt: now }
      });
    } catch {
      // The row that blocked the insert is already gone — a concurrent erasure. Rethrow
      // the original conflict rather than retrying: a loop here would be an unbounded
      // spin under adversarial load on an unauthenticated endpoint.
      throw error;
    }

    return { created: false };
  }
};
