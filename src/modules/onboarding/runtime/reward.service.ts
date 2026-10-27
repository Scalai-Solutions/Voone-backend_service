import { MemberRewardKind, type MemberReward, type PrismaClient } from "@prisma/client";

import { OnboardingError } from "../onboarding.service";
import { checkRedemption, isInSurprisePool } from "./rules";

/**
 * Listing and redeeming the rewards a member has been issued.
 *
 * Redemption is the rule the guide is most insistent about: it needs "a visit that includes a
 * payment or the consumption of a prepaid session", and "the backend must validate this; it is
 * not a staff convention". So a redemption is made AGAINST a PaidVisit, and the question of
 * whether that is allowed is answered by checkRedemption from rows the database holds — never
 * by a flag the caller asserts.
 */

export interface RedeemInput {
  clinicId: string;
  /** When given, the reward must belong to this member: the URL says whose it is. */
  memberId?: string;
  rewardId: string;
  /** The payment or package session this redemption happens in. */
  visitId?: string;
  redeemedBy?: string;
  /** For a surprise: the pool item the centre chose. */
  surpriseItem?: string;
}

export interface MemberRewardSummary {
  id: string;
  kind: MemberRewardKind;
  title: string;
  detail: unknown;
  issuedAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
  surpriseItem: string | null;
  /** What the screen should call it. Derived, so it is never stale. */
  status: "disponible" | "canjeado" | "caducado";
}

const statusOf = (reward: MemberReward, now: Date): MemberRewardSummary["status"] =>
  reward.redeemedAt
    ? "canjeado"
    : reward.expiresAt.getTime() <= now.getTime()
      ? "caducado"
      : "disponible";

const asDetail = (detail: unknown): { perk?: string; pool?: Array<{ id: string }> } =>
  detail && typeof detail === "object"
    ? (detail as { perk?: string; pool?: Array<{ id: string }> })
    : {};

/**
 * What the service needs to refresh a member's wallet card after a redemption. `PointsService`
 * satisfies it. Optional so a deployment without a wallet still redeems.
 */
export interface CardSyncPort {
  requestCardSync(memberId: string): Promise<void>;
}

export class RewardService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
    private readonly cardSync?: CardSyncPort
  ) {}

  /** A member's rewards, available ones first. Expired ones stay listed: they were promised. */
  async listForMember(clinicId: string, memberId: string): Promise<MemberRewardSummary[]> {
    const now = this.now();
    const rows = await this.prisma.memberReward.findMany({
      where: { clinicId, memberId },
      orderBy: [{ issuedAt: "desc" }]
    });

    const summaries = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      detail: r.detail,
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
      redeemedAt: r.redeemedAt,
      surpriseItem: r.surpriseItem,
      status: statusOf(r, now)
    }));

    const order = { disponible: 0, canjeado: 1, caducado: 2 } as const;

    return summaries.sort((a, b) => order[a.status] - order[b.status]);
  }

  async redeem(input: RedeemInput): Promise<MemberRewardSummary> {
    const now = this.now();
    const reward = await this.prisma.memberReward.findFirst({
      where: {
        id: input.rewardId,
        clinicId: input.clinicId,
        ...(input.memberId ? { memberId: input.memberId } : {})
      }
    });

    // The same answer whether it never existed or belongs to another centre: confirming
    // which would let one centre probe another's members.
    if (!reward) throw new OnboardingError("No existe ese premio.", 404);

    const detail = asDetail(reward.detail);

    if (reward.kind === MemberRewardKind.VENTAJA && detail.perk === "doble") {
      // Spent automatically by the next payment, so a manual redemption would only waste it.
      throw new OnboardingError(
        "Los puntos dobles se aplican solos en la próxima visita de pago; no se canjean a mano.",
        409
      );
    }

    const isSurprise = reward.kind === MemberRewardKind.VENTAJA && detail.perk === "sorpresa";

    if (isSurprise) {
      if (!input.surpriseItem) {
        throw new OnboardingError("Elige el regalo sorpresa de la lista antes de canjearlo.", 400);
      }

      if (!isInSurprisePool(detail.pool, input.surpriseItem)) {
        throw new OnboardingError("Ese regalo no está en la lista del premio sorpresa.", 400);
      }
    }

    const visit = input.visitId
      ? await this.prisma.paidVisit.findFirst({
          where: { id: input.visitId, clinicId: input.clinicId }
        })
      : null;

    const verdict = checkRedemption({
      reward: {
        clinicId: reward.clinicId,
        memberId: reward.memberId,
        redeemedAt: reward.redeemedAt,
        expiresAt: reward.expiresAt
      },
      visit: visit
        ? { clinicId: visit.clinicId, memberId: visit.memberId, occurredAt: visit.occurredAt }
        : null,
      now
    });

    if (!verdict.ok) throw new OnboardingError(verdict.message, 409);

    // The guard in the WHERE clause is what makes this safe under a race: two receptionists
    // redeeming the same reward at once both pass the check above, and exactly one update
    // matches a row that is still unredeemed.
    const updated = await this.prisma.memberReward.updateMany({
      where: { id: reward.id, redeemedAt: null },
      data: {
        redeemedAt: now,
        redeemedVisitId: visit!.id,
        redeemedBy: input.redeemedBy,
        surpriseItem: isSurprise ? input.surpriseItem : null
      }
    });

    if (updated.count === 0) throw new OnboardingError("Este premio ya se canjeó.", 409);

    // The card lists what can still be redeemed, so it is stale now. Never allowed to fail the
    // redemption, which is already recorded.
    try {
      await this.cardSync?.requestCardSync(reward.memberId);
    } catch (cause) {
      console.error(`[wallet] could not queue a card sync for member ${reward.memberId}:`, cause);
    }

    const fresh = await this.prisma.memberReward.findUniqueOrThrow({ where: { id: reward.id } });

    return {
      id: fresh.id,
      kind: fresh.kind,
      title: fresh.title,
      detail: fresh.detail,
      issuedAt: fresh.issuedAt,
      expiresAt: fresh.expiresAt,
      redeemedAt: fresh.redeemedAt,
      surpriseItem: fresh.surpriseItem,
      status: "canjeado"
    };
  }
}
