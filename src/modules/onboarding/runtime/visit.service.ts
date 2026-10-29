import {
  MemberBonoStatus,
  MemberRewardKind,
  PointsTransactionKind,
  VisitKind,
  VisitSource,
  type Prisma,
  type PrismaClient
} from "@prisma/client";

import { POST_CHANGE_SYNC_DELAY_MS } from "../../../wallet/engine/wallet-sync.queue";
import {
  doubleOfVisit,
  pendingDouble,
  REFERRAL_DOUBLE_REASON,
  type DoubleReason
} from "./double-points";
import { toPoints } from "./points-unit";
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
  earnsProgress,
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
import {
  bonoOutcome,
  nextBonoSession,
  sessionFits,
  statusAfterSession,
  type BonoOutcomeView
} from "../../bonos/bono-rules";
import { BONO_START_AT_MESSAGE, BONUS_POINTS_MESSAGE, BONUS_STEP } from "../../bonos/bono.schema";

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
  /** BONO_SESSION: the plan to start, or the member's active bono from it. */
  planId?: string;
  /** BONO_SESSION: the member's bono directly, e.g. one started at another till. */
  memberBonoId?: string;
  /** BONO_SESSION: legacy free-text package, recorded with no bono to track. */
  package?: { name?: string; priceEuro: number; sessions: number };
  /** BONO_SESSION: the session a member who already did sessions elsewhere starts at. */
  startAtSession?: number;
  /**
   * Bonus points awarded by hand with the visit, multiples of ten (the ledger holds whole
   * euros of progress). Added to the visit's progress before the single ledger credit, so
   * milestones and the pass see one number — never multiplied, never doubled by a perk.
   */
  bonusPoints?: number;
  /**
   * Set by reception when `bonusPoints` is the x2/x3/x5/x10 slider's flat extra rather than a
   * typed gift. While a x2 applies (a waiting perk or a referred client's first payment) the
   * visit is already x2 in total, so that extra is ignored: the visit is NOT refused.
   */
  boostMultiplier?: number;
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
  /** The same progress as the client sees it: ten points per euro. */
  points: number;
  /**
   * The member's SPENDABLE balance now, in points: the number her card shows. Not the lifetime
   * total (see lifetimePoints), which only drives the tier and diverges once anything was spent.
   */
  pointsTotal: number;
  /** Lifetime progress after this visit, in points. Internal to tiers; the card does not show it. */
  lifetimePoints: number;
  doubled: boolean;
  /** Why it was doubled (also on a retry); null when it was not. */
  doubleReason: DoubleReason | null;
  lifetimeBefore: number;
  lifetimeAfter: number;
  /** The tier held after this visit, as shown on the pass. */
  tier: string | null;
  issued: IssuedReward[];
  /** Discounted products still available this calendar year. */
  discountRemaining: number;
  /** The bono the session came out of; null for a payment visit or a legacy package. */
  bono: BonoOutcomeView | null;
  /** Whole points the progress gained from the bonus field, 0 when there was none. */
  bonusPoints: number;
}

/** The bono a BONO_SESSION visit consumes, resolved behind the member lock. */
interface ResolvedBono {
  id: string;
  name: string;
  /** 1-based session this visit records. */
  session: number;
  /** What the session earns, exactly: the plan's per-session price, in cents. */
  cents: number;
  totalSessions: number;
}

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

    if (!member) throw new OnboardingError("No existe esa persona en este centro.", 404);

    const existing = await this.prisma.paidVisit.findUnique({
      where: {
        clinicId_idempotencyKey: { clinicId: input.clinicId, idempotencyKey: input.idempotencyKey }
      }
    });

    if (existing && existing.memberId !== input.memberId) {
      // The key is the whole idempotency guarantee. Reusing one for a different person would
      // either credit the wrong client or silently drop a real payment.
      throw new OnboardingError("Esa clave de operación ya se usó para otra persona.", 409);
    }

    const opened = existing
      ? { visit: existing, created: false as const }
      : await this.open(input, active.view);

    const visit = opened.visit;
    // A first call answers from the decision it just took in open(), which is also what was
    // credited. Only a replay reads it back from the rows (see doubleOfVisit).
    const doubleReason: DoubleReason | null =
      "doubleReason" in opened ? opened.doubleReason : await doubleOfVisit(this.prisma, visit);
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
            reason:
              visit.kind !== VisitKind.PAYMENT
                ? "Sesión de bono"
                : doubleReason === "referral"
                  ? REFERRAL_DOUBLE_REASON
                  : "Visita de pago",
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

    // The credit above enqueued a card sync BEFORE these rewards existed, so that sync can build a
    // card without them. Ask again now that they are written.
    if (issued.length > 0) await this.requestCardSync(input.memberId);

    if (visit.kind === VisitKind.PAYMENT && visit.hasTreatment) {
      await this.countReferral(visit, active.id, active.view);
    }

    // The card's number: the cached spendable balance, read after the credit above settled it.
    // Read here rather than taken from the visit, so a retry of an old visit answers with what
    // the card shows now.
    const balance = await this.prisma.member.findUnique({
      where: { id: input.memberId },
      select: { pointsBalance: true }
    });

    const window = discountWindowStart(this.now());
    const used = await this.prisma.paidVisit.aggregate({
      where: { memberId: input.memberId, occurredAt: { gte: window } },
      _sum: { discountedProducts: true }
    });
    const tierView = active.view.tiers.find((t) => t.key === tierKeyOf(tier)) ?? null;
    const bono = visit.memberBonoId
      ? await this.bonoView(visit.memberBonoId, visit.bonoSessionNumber)
      : null;

    return {
      visitId: visit.id,
      duplicate: !opened.created,
      progress,
      points: toPoints(progress),
      pointsTotal: toPoints(balance?.pointsBalance ?? 0),
      lifetimePoints: toPoints(after),
      doubled: doubleReason !== null,
      doubleReason,
      lifetimeBefore: before,
      lifetimeAfter: after,
      tier,
      issued,
      discountRemaining: discountAllowance({
        tier: tierView,
        usedThisWindow: used._sum.discountedProducts ?? 0
      }),
      bono,
      bonusPoints: toPoints(visit.bonusProgress ?? 0)
    };
  }

  /** Never throws: a wallet outage must not fail a visit that is already recorded. */
  private async requestCardSync(memberId: string): Promise<void> {
    try {
      await this.points.requestCardSync(memberId, POST_CHANGE_SYNC_DELAY_MS);
    } catch (cause) {
      console.error(`[wallet] could not queue a card sync for member ${memberId}:`, cause);
    }
  }

  /** The outcome's bono block, the same for a first record and for a retry. */
  private async bonoView(
    memberBonoId: string,
    session: number | null
  ): Promise<BonoOutcomeView | null> {
    if (!session) return null;

    const bono = await this.prisma.memberBono.findUnique({ where: { id: memberBonoId } });

    return bono
      ? bonoOutcome(
          {
            id: bono.id,
            name: bono.name,
            totalSessions: bono.totalSessions,
            sessionsUsed: bono.sessionsUsed
          },
          session
        )
      : null;
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
    const discounted = input.discountedProducts ?? 0;

    if (
      input.bonusPoints !== undefined &&
      (input.bonusPoints < BONUS_STEP || input.bonusPoints % BONUS_STEP !== 0)
    ) {
      throw new OnboardingError(BONUS_POINTS_MESSAGE, 400);
    }

    const typedBonusEuros = (input.bonusPoints ?? 0) / BONUS_STEP;

    // Generous timeouts: the bono path runs several queries inside this transaction and
    // the database can be a hosted pooler far away — Prisma's 5-second default expires it
    // mid-flow and the next query answers P2028 against a closed handle.
    return this.prisma.$transaction(
      async (tx) => {
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

        if (dup) return { visit: dup, created: false as const };

        const member = await tx.member.findUniqueOrThrow({
          where: { id: input.memberId },
          select: { tier: true }
        });
        const tier = view.tiers.find((t) => t.key === tierKeyOf(member.tier)) ?? null;

        // Behind the same lock, so two sessions recorded at once cannot take the same number.
        const bono = input.kind === "BONO_SESSION" ? await this.resolveBono(tx, input) : null;
        const { cents, hasTreatment } = this.price(input, bono);

        if (discounted > 0) {
          const used = await tx.paidVisit.aggregate({
            where: {
              memberId: input.memberId,
              occurredAt: { gte: discountWindowStart(occurredAt) }
            },
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

        // The visit is doubled by a waiting double-points perk (the next payment in which money
        // changes hands, RUNTIME_DECISIONS.doublePointsAppliesTo) or by a referred client's first
        // payment; see double-points.ts, which the reception lookup shares. x2 in total, never x4.
        // A package session in between does not use either up, and neither does a payment that
        // earns no progress (a medicine-only basket): there is nothing to double, so nothing is
        // spent. When both are present the REFERRAL doubles the visit and the perk is KEPT for
        // the next one.
        const double =
          input.kind === "PAYMENT" && earnsProgress(cents)
            ? await pendingDouble(tx, input.memberId, occurredAt)
            : null;
        const perk = double?.reason === "perk" ? double.perkId : null;

        // The bonus is flat: no multiplier, no double-points perk, added before the single
        // credit so the milestones this visit crosses are judged on the whole number. The
        // slider's extra (flagged by reception) adds nothing while a x2 applies.
        const bonusEuros =
          double?.applies && input.boostMultiplier !== undefined ? 0 : typedBonusEuros;
        const progress =
          purchaseProgress({ cents, tier, doubled: Boolean(double?.applies) }) + bonusEuros;

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
            memberBonoId: bono?.id ?? null,
            bonoSessionNumber: bono?.session ?? null,
            bonusProgress: bonusEuros > 0 ? bonusEuros : null,
            progressAwarded: progress,
            lifetimeBefore: before,
            lifetimeAfter: before + progress,
            occurredAt,
            createdBy: input.createdBy
          }
        });

        // Consume the session in the same commit as the visit that used it: a crash between
        // the two cannot leave a session both recorded and still available.
        if (bono) {
          await tx.memberBono.update({
            where: { id: bono.id },
            data: {
              sessionsUsed: bono.session,
              status:
                statusAfterSession(
                  { totalSessions: bono.totalSessions, sessionsUsed: 0 },
                  bono.session
                ) === "COMPLETED"
                  ? MemberBonoStatus.COMPLETED
                  : MemberBonoStatus.ACTIVE
            }
          });
        }

        if (perk) {
          await tx.memberReward.update({
            where: { id: perk },
            data: { redeemedAt: occurredAt, redeemedVisitId: visit.id, redeemedBy: input.createdBy }
          });
        }

        return {
          visit,
          created: true as const,
          doubleReason: (double?.applies ? double.reason : null) as DoubleReason | null
        };
      },
      { timeout: 30_000, maxWait: 15_000 }
    );
  }

  /**
   * Which bono, which session. Directly by id, or by plan — which continues the member's
   * active bono from that plan, or starts one, optionally mid-way for a client who already
   * did sessions elsewhere. Null when the call carries only the legacy free-text package.
   */
  private async resolveBono(
    tx: Prisma.TransactionClient,
    input: RecordVisitInput
  ): Promise<ResolvedBono | null> {
    if (input.memberBonoId) {
      const bono = await tx.memberBono.findFirst({
        where: {
          id: input.memberBonoId,
          clinicId: input.clinicId,
          memberId: input.memberId,
          status: MemberBonoStatus.ACTIVE
        }
      });

      if (!bono) throw new OnboardingError("Ese bono no existe o ya no está activo.", 404);

      return this.sessionOf(bono);
    }

    if (input.planId) {
      const plan = await tx.bonoPlan.findFirst({
        where: { id: input.planId, clinicId: input.clinicId, active: true }
      });

      if (!plan) {
        throw new OnboardingError("No se ha encontrado ese bono o no está disponible.", 404);
      }

      // A member never holds two active bonos from one plan: choosing the plan again
      // continues the one they are on rather than silently starting a second.
      const existing = await tx.memberBono.findFirst({
        where: {
          memberId: input.memberId,
          clinicId: input.clinicId,
          planId: plan.id,
          status: MemberBonoStatus.ACTIVE
        }
      });

      if (existing) return this.sessionOf(existing);

      const start = input.startAtSession ?? 1;

      if (!sessionFits({ totalSessions: plan.totalSessions, sessionsUsed: 0 }, start)) {
        throw new OnboardingError(BONO_START_AT_MESSAGE, 400);
      }

      const created = await tx.memberBono.create({
        data: {
          clinicId: input.clinicId,
          memberId: input.memberId,
          planId: plan.id,
          name: plan.name,
          pricePerSessionCents: plan.pricePerSessionCents,
          totalSessions: plan.totalSessions,
          sessionsUsed: start - 1
        }
      });

      return {
        id: created.id,
        name: created.name,
        session: start,
        cents: plan.pricePerSessionCents,
        totalSessions: plan.totalSessions
      };
    }

    return null;
  }

  /** The next session of a bono already held, or a clear refusal when it is exhausted. */
  private sessionOf(bono: {
    id: string;
    name: string;
    pricePerSessionCents: number;
    totalSessions: number;
    sessionsUsed: number;
  }): ResolvedBono {
    const session = nextBonoSession(bono);

    if (!sessionFits(bono, session)) {
      throw new OnboardingError("Ese bono ya no tiene sesiones disponibles.", 409);
    }

    return {
      id: bono.id,
      name: bono.name,
      session,
      cents: bono.pricePerSessionCents,
      totalSessions: bono.totalSessions
    };
  }

  /** What the visit earns, and whether it counts as treatment — or a clear refusal. */
  private price(
    input: RecordVisitInput,
    bono: ResolvedBono | null
  ): { cents: number; hasTreatment: boolean } {
    if (input.kind === "BONO_SESSION") {
      // A tracked bono's session is worth exactly what the plan says per session.
      if (bono) return { cents: bono.cents, hasTreatment: true };

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

    const created = await this.prisma.memberReward.createMany({
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

    // The reward lands on the REFERRER's card, whose owner is not the one at reception.
    if (created.count > 0) await this.requestCardSync(counted.referrerId);
  }
}
