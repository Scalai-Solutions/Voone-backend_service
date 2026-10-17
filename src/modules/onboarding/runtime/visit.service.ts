import {
  MemberRewardKind,
  PointsTransactionKind,
  VisitKind,
  VisitSource,
  type Prisma,
  type PrismaClient
} from "@prisma/client";

import type { PointsService } from "../../points/points.service";
import { toCents } from "../catalog.repository";
import type { CategoryCode } from "../engine.types";
import { CATEGORIES } from "../engine.config";
import { OnboardingError } from "../onboarding.service";
import { activeProgramView } from "./program-tier.port";
import type { ProgramView } from "./program-view";
import {
  bonoSessionCents,
  discountAllowance,
  discountWindowStart,
  earningCents,
  includesTreatment,
  milestonesCrossed,
  purchaseProgress,
  recurringCrossed,
  referralRewardAt,
  rewardExpiry,
  tierKeyOf,
  type PurchaseLine
} from "./rules";

/**
 * Recording a visit: the moment a payment becomes progress.
 *
 * Everything the guide calls a runtime rule converges here. A paid euro becomes progress at
 * the multiplier of the tier held WHEN IT WAS PAID; a waiting double-points perk is spent; every
 * milestone the progress crosses is issued, not just the highest; and a referred client's first
 * treatment payment counts for the person who sent them.
 *
 * RETRY-SAFE BY CONSTRUCTION. Reception taps twice, a request times out, a worker restarts. The
 * work is split at one commit: first the visit is written with the numbers it will award, under
 * a lock on the member; then the ledger credit, the rewards and the referral are applied, each
 * idempotent on its own key. A retry finds the visit and re-runs the second half, so a crash at
 * any point leaves a state the next call completes rather than one that has to be repaired.
 */

export interface VisitLine {
  category?: CategoryCode;
  amountEuro: number;
}

export interface RecordVisitInput {
  clinicId: string;
  memberId: string;
  kind: "PAYMENT" | "BONO_SESSION";
  /** PAYMENT: what was paid, by category, so retail and medicine can be told apart. */
  lines?: VisitLine[];
  /** BONO_SESSION: the package this session came out of. */
  package?: { priceEuro: number; sessions: number };
  /** Cosmetics bought at the tier discount in this visit. */
  discountedProducts?: number;
  /** Minted by the caller, so a double tap cannot pay a client twice. */
  idempotencyKey: string;
  createdBy?: string;
  /** Defaults to now. */
  occurredAt?: Date;
}

export interface IssuedReward {
  id: string;
  kind: MemberRewardKind;
  title: string;
  expiresAt: Date;
}

export interface VisitOutcome {
  visitId: string;
  /** True when this call found the visit already recorded. Not an error: same result. */
  duplicate: boolean;
  /** Progress euros awarded, after the multiplier and any doubling. */
  progress: number;
  doubled: boolean;
  lifetimeBefore: number;
  lifetimeAfter: number;
  /** The tier held after this visit, as shown on the pass. */
  tier: string | null;
  issued: IssuedReward[];
  /** Discounted products still available this calendar year. */
  discountRemaining: number;
}

const DOUBLE_PERK = "doble";

export class VisitService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly points: PointsService,
    private readonly now: () => Date = () => new Date()
  ) {}

  async record(input: RecordVisitInput): Promise<VisitOutcome> {
    const active = await activeProgramView(this.prisma, input.clinicId);

    if (!active) {
      throw new OnboardingError(
        "El centro todavía no tiene un programa activo. Actívalo antes de registrar visitas.",
        409
      );
    }

    const member = await this.prisma.member.findFirst({
      where: { id: input.memberId, clinicId: input.clinicId, erasedAt: null },
      select: { id: true }
    });

    if (!member) throw new OnboardingError("No existe esa clienta en este centro.", 404);

    const existing = await this.prisma.paidVisit.findUnique({
      where: {
        clinicId_idempotencyKey: { clinicId: input.clinicId, idempotencyKey: input.idempotencyKey }
      }
    });

    if (existing && existing.memberId !== input.memberId) {
      // The key is the whole idempotency guarantee. Reusing one for a different person would
      // either credit the wrong client or silently drop a real payment.
      throw new OnboardingError("Esa clave de operación ya se usó para otra clienta.", 409);
    }

    const opened = existing
      ? { visit: existing, created: false, doubled: false }
      : await this.open(input, active.view);

    const visit = opened.visit;
    const progress = visit.progressAwarded ?? 0;
    const before = visit.lifetimeBefore ?? 0;
    const after = visit.lifetimeAfter ?? before + progress;

    // Second half: every step idempotent, so a retry after a crash simply finishes the job.
    let tier: string | null = null;

    if (progress > 0) {
      // One credit at a time per member. The ledger append is safe on its own, but settling
      // reads the balance and then writes the member's cached total: two credits settling at once
      // can each read a balance that misses the other and the later write leaves a stale total.
      const credit = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`visit-credit:${input.memberId}`}))`;

          return this.points.credit({
            memberId: input.memberId,
            clinicId: input.clinicId,
            points: progress,
            kind: PointsTransactionKind.EARN,
            reason: visit.kind === VisitKind.PAYMENT ? "Visita de pago" : "Sesión de bono",
            sourceRef: visit.id,
            idempotencyKey: `visit:${visit.id}`,
            createdBy: input.createdBy
          });
        },
        { timeout: 15_000, maxWait: 15_000 }
      );

      tier = credit.tier?.label ?? null;
    } else {
      const row = await this.prisma.member.findUnique({
        where: { id: input.memberId },
        select: { tier: true }
      });
      tier = row?.tier ?? null;
    }

    const issued = await this.issue(visit, active.id, active.version, active.view, before, after);

    if (visit.kind === VisitKind.PAYMENT && visit.hasTreatment) {
      await this.countReferral(visit, active.id, active.view);
    }

    const window = discountWindowStart(this.now());
    const used = await this.prisma.paidVisit.aggregate({
      where: { memberId: input.memberId, occurredAt: { gte: window } },
      _sum: { discountedProducts: true }
    });
    const tierView = active.view.tiers.find((t) => t.key === tierKeyOf(tier)) ?? null;

    return {
      visitId: visit.id,
      duplicate: !opened.created,
      progress,
      doubled: Boolean(opened.doubled),
      lifetimeBefore: before,
      lifetimeAfter: after,
      tier,
      issued,
      discountRemaining: discountAllowance({
        tier: tierView,
        usedThisWindow: used._sum.discountedProducts ?? 0
      })
    };
  }

  /**
   * The first half: validate, lock the member, and write the visit with what it will award.
   *
   * Under a lock on the member row so two visits for the same person cannot both read the same
   * starting balance, which would hand out the same milestones twice and apply a multiplier
   * the first visit was about to change.
   */
  private async open(input: RecordVisitInput, view: ProgramView) {
    const occurredAt = input.occurredAt ?? this.now();
    const { cents, hasTreatment } = this.price(input);
    const discounted = input.discountedProducts ?? 0;

    return this.prisma.$transaction(async (tx) => {
      // The lock is the point. Everything below reads what a concurrent visit would change.
      await tx.$queryRaw`SELECT id FROM "Member" WHERE id = ${input.memberId} FOR UPDATE`;

      // A duplicate that raced past the first check lands here, behind the lock.
      const dup = await tx.paidVisit.findUnique({
        where: {
          clinicId_idempotencyKey: {
            clinicId: input.clinicId,
            idempotencyKey: input.idempotencyKey
          }
        }
      });

      if (dup) return { visit: dup, created: false, doubled: false };

      const member = await tx.member.findUniqueOrThrow({
        where: { id: input.memberId },
        select: { tier: true }
      });
      const tier = view.tiers.find((t) => t.key === tierKeyOf(member.tier)) ?? null;

      if (discounted > 0) {
        const used = await tx.paidVisit.aggregate({
          where: { memberId: input.memberId, occurredAt: { gte: discountWindowStart(occurredAt) } },
          _sum: { discountedProducts: true }
        });
        const allowed = discountAllowance({
          tier,
          usedThisWindow: used._sum.discountedProducts ?? 0
        });

        if (discounted > allowed) {
          throw new OnboardingError(
            allowed === 0
              ? "Su nivel no tiene descuento en cosmética, o ya usó los 3 productos de este año."
              : `Solo puede comprar ${allowed} ${allowed === 1 ? "producto" : "productos"} más con descuento este año.`,
            409
          );
        }
      }

      // Balance before this visit. The ledger is the truth, but a previous visit may have
      // committed its snapshot and not yet credited, so the larger of the two is used: that
      // visit's number is exactly what the ledger is about to say.
      const ledger = await this.points.balanceFor(input.memberId);
      const last = await tx.paidVisit.findFirst({
        where: { memberId: input.memberId, lifetimeAfter: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { lifetimeAfter: true }
      });
      const before = Math.max(ledger.lifetime, last?.lifetimeAfter ?? 0);

      // A waiting double-points perk applies to the next visit in which money changes hands
      // (RUNTIME_DECISIONS.doublePointsAppliesTo). A package session in between does not
      // use it up, because that session's value was fixed when the package was bought.
      const perk =
        input.kind === "PAYMENT"
          ? await tx.memberReward.findFirst({
              where: {
                memberId: input.memberId,
                kind: MemberRewardKind.VENTAJA,
                redeemedAt: null,
                expiresAt: { gt: occurredAt },
                detail: { path: ["perk"], equals: DOUBLE_PERK }
              },
              orderBy: { issuedAt: "asc" }
            })
          : null;

      const progress = purchaseProgress({ cents, tier, doubled: Boolean(perk) });

      const visit = await tx.paidVisit.create({
        data: {
          clinicId: input.clinicId,
          memberId: input.memberId,
          kind: input.kind === "PAYMENT" ? VisitKind.PAYMENT : VisitKind.BONO_SESSION,
          source: VisitSource.STAFF_ENTRY,
          // What EARNS progress, not what was paid: the table holds the number the maths used.
          amountCents: cents,
          hasTreatment,
          discountedProducts: discounted,
          idempotencyKey: input.idempotencyKey,
          progressAwarded: progress,
          lifetimeBefore: before,
          lifetimeAfter: before + progress,
          occurredAt,
          createdBy: input.createdBy
        }
      });

      if (perk) {
        await tx.memberReward.update({
          where: { id: perk.id },
          data: { redeemedAt: occurredAt, redeemedVisitId: visit.id, redeemedBy: input.createdBy }
        });
      }

      return { visit, created: true, doubled: Boolean(perk) };
    });
  }

  /** What the visit earns, and whether it counts as treatment — or a clear refusal. */
  private price(input: RecordVisitInput): { cents: number; hasTreatment: boolean } {
    if (input.kind === "BONO_SESSION") {
      const pack = input.package;

      if (!pack || !(pack.priceEuro > 0) || !Number.isInteger(pack.sessions) || pack.sessions < 1) {
        throw new OnboardingError("Indica el precio del bono y su número de sesiones.", 400);
      }

      const cents = bonoSessionCents(toCents(pack.priceEuro), pack.sessions);

      return { cents, hasTreatment: true };
    }

    const lines = input.lines ?? [];
    const asLines: PurchaseLine[] = lines.map((l) => ({
      category: l.category,
      amountCents: toCents(l.amountEuro)
    }));
    const totalCents = asLines.reduce((sum, l) => sum + l.amountCents, 0);

    if (!lines.length || totalCents <= 0) {
      throw new OnboardingError("Una visita de pago necesita al menos un importe.", 400);
    }

    for (const line of lines) {
      if (line.category && !CATEGORIES[line.category]) {
        throw new OnboardingError(`Categoría desconocida: ${line.category}.`, 400);
      }
      if (!(line.amountEuro >= 0)) {
        throw new OnboardingError("Los importes no pueden ser negativos.", 400);
      }
    }

    return { cents: earningCents(asLines), hasTreatment: includesTreatment(asLines) };
  }

  /**
   * Issue every reward the visit's progress crossed. Idempotent on (member, sourceKey).
   *
   * The key carries the programme VERSION. A milestone's number is only its position, and a new
   * version puts a different threshold at the same position: without the version, a member who
   * was issued the old seventh milestone would silently never be issued the new one, because the
   * key already exists. Progress is stored in euros, so a member keeps hers across a version
   * and is simply placed on the new ladder; crossing is judged on progress, so a step she has
   * already passed on the new ladder is not issued again.
   */
  private async issue(
    visit: { id: string; clinicId: string; memberId: string; occurredAt: Date },
    programId: string,
    version: number,
    view: ProgramView,
    before: number,
    after: number
  ): Promise<IssuedReward[]> {
    const expiresAt = rewardExpiry(visit.occurredAt);
    const base = {
      clinicId: visit.clinicId,
      memberId: visit.memberId,
      programId,
      issuedAt: visit.occurredAt,
      expiresAt
    };

    const rows: Prisma.MemberRewardCreateManyInput[] = [
      ...milestonesCrossed(view, before, after).map((m) => ({
        ...base,
        kind: m.issue!.kind === "PREMIO" ? MemberRewardKind.PREMIO : MemberRewardKind.VENTAJA,
        sourceKey: `v${version}:m:${m.n}`,
        title: m.issue!.title,
        detail: m.issue!.detail as unknown as Prisma.InputJsonValue
      })),
      ...recurringCrossed(view, before, after).map((k) => ({
        ...base,
        kind: MemberRewardKind.RECURRENTE,
        sourceKey: `v${version}:rec:${k}`,
        title: view.recurring.title,
        detail: { every: view.recurring.every } as Prisma.InputJsonValue
      }))
    ];

    if (!rows.length) return [];

    await this.prisma.memberReward.createMany({ data: rows, skipDuplicates: true });

    const found = await this.prisma.memberReward.findMany({
      where: { memberId: visit.memberId, sourceKey: { in: rows.map((r) => r.sourceKey) } },
      orderBy: { issuedAt: "asc" }
    });

    return found.map((r) => ({ id: r.id, kind: r.kind, title: r.title, expiresAt: r.expiresAt }));
  }

  /**
   * On a referred client's first payment for a treatment, count it for the referrer.
   *
   * "Sign-up alone does not count." Counted only on the earliest treatment payment, and the
   * referrer's reward is keyed by the referral's RANK, so running this twice — a retry, or a
   * crash between the count and the reward — issues it once.
   */
  private async countReferral(
    visit: { id: string; memberId: string; clinicId: string; occurredAt: Date },
    programId: string,
    view: ProgramView
  ): Promise<void> {
    const referral = await this.prisma.referral.findUnique({
      where: { referredId: visit.memberId }
    });

    if (!referral) return;

    const first = await this.prisma.paidVisit.findFirst({
      where: { memberId: visit.memberId, kind: VisitKind.PAYMENT, hasTreatment: true },
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true }
    });

    // Only the earliest treatment payment is the qualifying one.
    if (first?.id !== visit.id) return;

    await this.prisma.referral.updateMany({
      where: { id: referral.id, countedAt: null },
      data: { countedAt: visit.occurredAt }
    });

    const counted = await this.prisma.referral.findUniqueOrThrow({ where: { id: referral.id } });

    if (!counted.countedAt) return;

    // This referral's position among the referrer's counted ones, in the order they counted.
    const rank = await this.prisma.referral.count({
      where: {
        referrerId: counted.referrerId,
        countedAt: { not: null },
        OR: [
          { countedAt: { lt: counted.countedAt } },
          { countedAt: counted.countedAt, id: { lte: counted.id } }
        ]
      }
    });

    const reward = referralRewardAt(view, rank);

    if (!reward) return;

    await this.prisma.memberReward.createMany({
      data: [
        {
          clinicId: visit.clinicId,
          memberId: counted.referrerId,
          programId,
          kind: MemberRewardKind.REFERIDO,
          sourceKey: reward.sourceKey,
          title: reward.title,
          detail: { referral: rank, step: reward.step } as Prisma.InputJsonValue,
          issuedAt: counted.countedAt,
          expiresAt: rewardExpiry(counted.countedAt)
        }
      ],
      skipDuplicates: true
    });
  }
}
