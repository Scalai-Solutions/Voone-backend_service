import { MemberRewardKind, type MemberReward, type PrismaClient } from "@prisma/client";

import { POST_CHANGE_SYNC_DELAY_MS } from "../../../wallet/engine/wallet-sync.queue";
import { OnboardingError } from "../onboarding.service";
import { publicDouble, pendingDouble, type DoublePoints } from "./double-points";
import {
  checkRedemption,
  isDoublePointsPerk,
  isInSurprisePool,
  REDEMPTION_REFUSALS,
  sameClinicDay
} from "./rules";
import { giftSaving, parsePerkValues, recordSaving } from "./savings";

/**
 * Listing and redeeming the rewards a member has been issued.
 *
 * A reward can be redeemed at any time before it expires; a paid visit is no longer required
 * (checkRedemption explains why). When reception redeems during a visit recorded today, the
 * redemption is linked to it (`redeemedVisitId`); otherwise it stands on its own.
 */

export interface RedeemInput {
  clinicId: string;
  /** When given, the reward must belong to this member: the URL says whose it is. */
  memberId?: string;
  rewardId: string;
  /** The payment or package session this redemption happens in, if any. Optional. */
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

/**
 * A reward's stored `detail` as a screen may read it. The row keeps the retail value of the gift
 * (and of each item) because choosing and issuing needed it, but the centre's browser must not
 * learn what a gift is worth: names and ids stay, `value` goes. Stored rows are not touched.
 */
export const publicDetail = (detail: unknown): unknown => {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return detail;

  const { value: _value, items, ...rest } = detail as { value?: unknown; items?: unknown };

  void _value;

  return Array.isArray(items)
    ? {
        ...rest,
        items: items.map((i) => {
          const { id, name } = (i ?? {}) as { id?: unknown; name?: unknown };

          return { id, name };
        })
      }
    : rest;
};

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
  requestCardSync(memberId: string, delayMs?: number): Promise<void>;
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
      detail: publicDetail(r.detail),
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
      redeemedAt: r.redeemedAt,
      surpriseItem: r.surpriseItem,
      status: statusOf(r, now)
    }));

    const order = { disponible: 0, canjeado: 1, caducado: 2 } as const;

    return summaries.sort((a, b) => order[a.status] - order[b.status]);
  }

  /**
   * Whether this member's next payment will be doubled, and why. The very same decision the visit
   * credit takes (double-points.ts), so the reception screen and the credit cannot disagree.
   */
  async doublePoints(clinicId: string, memberId: string): Promise<DoublePoints> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, clinicId },
      select: { id: true }
    });

    if (!member) return publicDouble({ applies: false, reason: null, until: null });

    return publicDouble(await pendingDouble(this.prisma, memberId, this.now()));
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

    if (isDoublePointsPerk(reward.kind, reward.detail)) {
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

    // A visit named but not found at this centre is not this client's: refuse rather than
    // quietly redeem without it.
    if (input.visitId && !visit) {
      throw new OnboardingError(REDEMPTION_REFUSALS.visita_ajena, 409);
    }

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
    //
    // What the gift saved the member is written in the same transaction, only once this update has
    // won: a redemption that lost the race must not count, and one that counts must not be lost.
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.memberReward.updateMany({
        where: { id: reward.id, redeemedAt: null },
        data: {
          redeemedAt: now,
          // Linked only to a visit from today: a visit id kept by an old browser tab must not
          // make a redemption look as if it happened on another day.
          redeemedVisitId: visit && sameClinicDay(visit.occurredAt, now) ? visit.id : null,
          redeemedBy: input.redeemedBy,
          surpriseItem: isSurprise ? input.surpriseItem : null
        }
      });

      if (result.count === 0) return result;

      const clinic = await tx.clinic.findUnique({
        where: { id: reward.clinicId },
        select: { perkValues: true }
      });
      const saving = giftSaving(reward.kind, reward.detail, parsePerkValues(clinic?.perkValues));

      if (saving) {
        await recordSaving(tx, {
          clinicId: reward.clinicId,
          memberId: reward.memberId,
          kind: saving.kind,
          cents: saving.cents,
          sourceKey: `reward:${reward.id}`,
          createdBy: input.redeemedBy
        });
      }

      return result;
    });

    if (updated.count === 0) throw new OnboardingError("Este premio ya se canjeó.", 409);

    // The card lists what can still be redeemed, so it is stale now. Never allowed to fail the
    // redemption, which is already recorded.
    try {
      await this.cardSync?.requestCardSync(reward.memberId, POST_CHANGE_SYNC_DELAY_MS);
    } catch (cause) {
      console.error(`[wallet] could not queue a card sync for member ${reward.memberId}:`, cause);
    }

    const fresh = await this.prisma.memberReward.findUniqueOrThrow({ where: { id: reward.id } });

    return {
      id: fresh.id,
      kind: fresh.kind,
      title: fresh.title,
      detail: publicDetail(fresh.detail),
      issuedAt: fresh.issuedAt,
      expiresAt: fresh.expiresAt,
      redeemedAt: fresh.redeemedAt,
      surpriseItem: fresh.surpriseItem,
      status: "canjeado"
    };
  }
}
