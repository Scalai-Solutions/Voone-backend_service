import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/**
 * Fifteen minutes.
 *
 * The member is looking at the confirmation page on the phone the card is for, so the
 * useful life of a claim is measured in seconds. The window exists to cover a slow tap
 * and a retry, not to be a link anyone keeps — a claim URL ends up in browser history
 * and in whatever the phone syncs, and a short expiry is what makes that harmless.
 */
export const CLAIM_TTL_MS = 15 * 60 * 1000;

/** 32 bytes, base64url. Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

export interface PassClaimService {
  /** Issues a claim for a member. The plain token is returned once and never stored. */
  mint(memberId: string, now?: Date): Promise<string>;
  /** The member this token is good for, or null if it is unknown or expired. */
  resolve(token: string, now?: Date): Promise<string | null>;
}

export class PrismaPassClaimService implements PassClaimService {
  constructor(private readonly prisma: PrismaClient) {}

  async mint(memberId: string, now: Date = new Date()): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");

    await this.prisma.passClaim.create({
      data: {
        tokenHash: hash(token),
        memberId,
        expiresAt: new Date(now.getTime() + CLAIM_TTL_MS)
      }
    });

    return token;
  }

  async resolve(token: string, now: Date = new Date()): Promise<string | null> {
    // Looked up by hash, so the stored row is useless to anyone who reads the database.
    const claim = await this.prisma.passClaim.findUnique({
      where: { tokenHash: hash(token) },
      select: { id: true, memberId: true, expiresAt: true, claimedAt: true }
    });

    // Unknown and expired are the same answer. There is nothing to compare in constant
    // time here: the lookup is by SHA-256 of the token against a unique index, so the
    // database has already done the equality test and a timing difference cannot reveal
    // a preimage.
    if (!claim) return null;

    if (claim.expiresAt.getTime() <= now.getTime()) return null;

    // Recorded, not enforced. A member whose "Add to Wallet" fails must be able to tap
    // again, and re-submitting the sign-up form would answer "already a member" and
    // hand back no new token — so a strict single use would strand them.
    if (!claim.claimedAt) {
      await this.prisma.passClaim.update({
        where: { id: claim.id },
        data: { claimedAt: now }
      });
    }

    return claim.memberId;
  }

  /**
   * Deletes expired rows. Not scheduled anywhere yet, and deliberately not run on the
   * request path: a member waiting for a card should not pay for housekeeping.
   */
  async sweep(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.passClaim.deleteMany({
      where: { expiresAt: { lt: now } }
    });

    return count;
  }
}
