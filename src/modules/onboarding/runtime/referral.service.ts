import { PointsTransactionKind, type PrismaClient } from "@prisma/client";

import { POST_CHANGE_SYNC_DELAY_MS } from "../../../wallet/engine/wallet-sync.queue";
import type { PointsService } from "../../points/points.service";
import { activeProgramView } from "./program-tier.port";
import { sameIdentity } from "./rules";

/**
 * Recording who sent a new member.
 *
 * A referral is created here, at sign-up, and COUNTS later: only on the referred person's first
 * payment for a treatment (see VisitService). Sign-up alone earns the referrer nothing, which is
 * the guide's rule and also what makes the whole mechanism hard to farm — creating an account is
 * free, paying for a treatment is not.
 */

export type ReferralOutcome =
  | { registered: true; referrerId: string }
  | {
      registered: false;
      reason: "no_referrer" | "self" | "already_referred" | "too_late" | "no_program";
    };

export class ReferralService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly points: PointsService
  ) {}

  /**
   * Link a new member to the person who sent them, by that person's five-character code.
   *
   * NEVER throws on a bad code. This runs inside the public sign-up flow, where a mistyped code
   * must not cost someone their membership — and where distinguishing "no such code" from
   * "valid but refused" in a response would let anyone enumerate a centre's member codes.
   * The reason is returned for the caller's logs, not for the person typing.
   */
  async register(input: {
    clinicId: string;
    referredMemberId: string;
    code: string;
  }): Promise<ReferralOutcome> {
    const code = input.code.trim().toUpperCase();

    if (!code) return { registered: false, reason: "no_referrer" };

    const active = await activeProgramView(this.prisma, input.clinicId);

    // Without a programme there is nothing to reward, and recording a referral nobody can
    // ever count would only create rows that look meaningful and are not.
    if (!active) return { registered: false, reason: "no_program" };

    const referrer = await this.prisma.member.findFirst({
      where: { clinicId: input.clinicId, code, erasedAt: null },
      select: { id: true, phone: true, email: true }
    });

    if (!referrer) return { registered: false, reason: "no_referrer" };

    const referred = await this.prisma.member.findFirst({
      where: { id: input.referredMemberId, clinicId: input.clinicId, erasedAt: null },
      select: { id: true, phone: true, email: true }
    });

    if (!referred) return { registered: false, reason: "no_referrer" };

    // Same record, same phone or same email: the guide asks to guard against both
    // self-referral and duplicate people.
    if (sameIdentity(referrer, referred)) return { registered: false, reason: "self" };

    // A referral is for someone NEW. Attaching one to a member who has already paid would let
    // a regular client be "recommended" retroactively by a friend.
    const paid = await this.prisma.paidVisit.count({ where: { memberId: referred.id } });

    if (paid > 0) return { registered: false, reason: "too_late" };

    try {
      await this.prisma.referral.create({
        data: { clinicId: input.clinicId, referrerId: referrer.id, referredId: referred.id }
      });
    } catch (error) {
      // referredId is unique: a person is recommended once, and the first claim stands.
      if ((error as { code?: string }).code === "P2002") {
        return { registered: false, reason: "already_referred" };
      }

      throw error;
    }

    // The referred person starts part of the way up the ladder. REFERRAL is a lifetime kind,
    // so it counts towards tier as well as balance — and it is keyed so a retry cannot pay it
    // twice.
    if (active.view.welcome > 0) {
      await this.points.credit({
        memberId: referred.id,
        clinicId: input.clinicId,
        points: active.view.welcome,
        kind: PointsTransactionKind.REFERRAL,
        reason: "Bienvenida por recomendación",
        sourceRef: referrer.id,
        idempotencyKey: `welcome:${referred.id}`
      });
    }

    // The card now says "your first visit earns double" (and, for the referrer's own card, nothing
    // changes). The welcome credit above syncs too, but only when there is one, and before the
    // referral is the whole story; asking again is cheap and never fails the sign-up.
    await this.points.requestCardSync(referred.id, POST_CHANGE_SYNC_DELAY_MS);

    return { registered: true, referrerId: referrer.id };
  }
}
