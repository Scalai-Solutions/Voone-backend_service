import { LoyaltyCard } from "./loyalty-card";

/**
 * Builds a member's card from whatever currently holds the truth about their points.
 *
 * The seam, and the reason it exists: today the truth is Member.pointsBalance, tomorrow
 * it is the points ledger. Both wallet adapters depend on this interface rather than on
 * either source, so when the ledger lands one class is replaced and no adapter is touched.
 * It is the same dependency inversion that lets Apple and Google be built in parallel,
 * applied one layer down.
 *
 * Assembling in exactly one place is also what stops the two providers disagreeing about
 * what a member's card says.
 */
export interface LoyaltyCardAssembler {
  assemble(memberId: string): Promise<LoyaltyCard>;
}
