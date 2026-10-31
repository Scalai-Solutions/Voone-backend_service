import { MemberRewardKind, OnboardingProgramStatus, type PrismaClient } from "@prisma/client";

import { MemberNotFoundError } from "../common/errors/membership.errors";
import { WalletConfigurationError } from "../common/errors/wallet.errors";
import { LoyaltyCardAssembler } from "./engine/loyalty-card-assembler";
import { LoyaltyCard, loyaltyCardSchema, MEMBER_CODE_PATTERN } from "./engine/loyalty-card";
import { formatCardMessage } from "./engine/card-message";
import { extraButtonsOf } from "./engine/program-template";
import { clipCardText } from "./engine/card-text";
import { clipText } from "./engine/rewards-text";
import { fitTierBenefits } from "./engine/tier-benefits-text";
import { deriveRedemptionCode } from "./engine/redemption-code";
import { milestoneProgress } from "../modules/points/milestone-engine";
import type { Program } from "../modules/onboarding/engine.types";
import { presentProgram } from "../modules/onboarding/presentation";
import { programView } from "../modules/onboarding/runtime/program-view";
import { toPoints } from "../modules/onboarding/runtime/points-unit";
import {
  chooseDouble,
  DOUBLE_PERK,
  isReferralPending,
  PERK_ORDER
} from "../modules/onboarding/runtime/double-points";
import { isDoublePointsPerk, nextRewardFor } from "../modules/onboarding/runtime/rules";
import { tierRewardsSchema } from "../modules/templates/templates.schema";

/**
 * Assembles a card from Member.pointsBalance and Member.tier.
 *
 * No longer temporary. Those columns are a CACHE of the points ledger, maintained by
 * PointsService on every movement and rebuildable at any time with
 * `npm run points:recompute`. Reading them here rather than summing the ledger is
 * deliberate: a pass is rebuilt on issue, on every sync and on every device fetch, and
 * a member with years of visits should not cost a full history scan each time.
 *
 * The consequence to know: if a process dies between the ledger append and the cache
 * write, a card can render one movement behind until the next movement or a recompute.
 * The ledger is always right; the card can briefly be stale. That trade is the reason
 * the recompute script exists.
 */
/**
 * "PRÓXIMA RECOMPENSA" on the pass, and the progress bar beside it.
 *
 * Undefined rather than a placeholder when it cannot be computed — the pass builder
 * omits both fields entirely, which is the honest rendering of "this clinic has not
 * configured a ladder yet". A zeroed bar would look like a member who has earned
 * nothing.
 */
const rewardFor = (
  member: { tier: string | null; lifetimePoints: number },
  tierRewards: unknown
): { description: string; progressPercent: number } | undefined => {
  if (!member.tier) return undefined;

  const parsed = tierRewardsSchema.safeParse(tierRewards);

  if (!parsed.success) return undefined;

  const tier = parsed.data.find((candidate) => candidate.name === member.tier);

  if (!tier) return undefined;

  const progress = milestoneProgress(member.lifetimePoints, tier);

  // The clinic's own words where it wrote them, and a plain count where it did not.
  // Never a treatment name: tierRewards is marketing copy the clinic authored, and the
  // ledger it is derived from holds no treatments.
  const description = tier.rewardText?.trim()
    ? tier.rewardText.trim()
    : `Recompensa ${Math.min(progress.reached + 1, progress.total)} de ${progress.total}`;

  return {
    // The pass caps this at 120 characters, and a clinic can type more than that.
    description: description.slice(0, 120),
    progressPercent: progress.progressPercent
  };
};

/**
 * "PRÓXIMA RECOMPENSA" for a member of a clinic that runs an onboarding programme.
 *
 * The founders' end-to-end feedback (item 50) overrides the guide here: the distance is stated in
 * POINTS (one euro is ten), the same unit as the balance shown beside it. The bar shows how far
 * through that step the client is.
 *
 * The pass caps the description at 120 characters and a reward can be a pack of two long item
 * names, so the name is shortened and the distance — the part the member acts on — never is.
 */
const programRewardFor = (
  programOutput: unknown,
  lifetimePoints: number
):
  | { description: string; progressPercent: number; title?: string; remainingPoints?: number }
  | undefined => {
  const next = nextRewardFor(programView(programOutput as Program), lifetimePoints);

  if (!next) return undefined;

  const tail = ` · te faltan ${toPoints(next.remaining).toLocaleString("es-ES")} puntos`;
  const room = 120 - tail.length;
  const title =
    next.title.length > room ? `${next.title.slice(0, room - 1).trimEnd()}…` : next.title;

  return {
    description: `${title}${tail}`,
    progressPercent: next.percent,
    title: next.title.slice(0, 120),
    remainingPoints: toPoints(next.remaining)
  };
};

/**
 * The benefits of the member's current tier, from the live programme (the one place they are
 * defined: the engine's rules plus the clinic's own lines, merged by `presentProgram`).
 *
 * Undefined when the member has no tier, the tier is not in the programme, or it has nothing to
 * say. A programme that cannot be presented must not stop the member's card: it falls back to the
 * template's text, as a clinic with no programme does.
 */
const tierBenefitsFor = (
  programOutput: unknown,
  tier: string | null
): { tier: string; lines: string[] } | undefined => {
  if (!tier) return undefined;

  try {
    const presented = presentProgram(programOutput as Program).tiers.find(
      (candidate) => candidate.label === tier
    );

    if (!presented) return undefined;

    const lines = fitTierBenefits(presented.label, presented.benefits);

    return lines.length > 0 ? { tier: presented.label, lines } : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The x2 waiting for the member's next visit, decided by the SAME function the visit credit and the
 * reception lookup use (double-points.ts), so the card never promises what the credit will not do.
 *
 * Called for a programme centre only, so a legacy clinic pays no extra query. The waiting perk is
 * among the open rewards the member query already loaded; the referral is looked up first and the
 * paid visit only when there is one. Only when the card's list is full (20 rewards) and shows no
 * perk is the perk asked for on its own, so a perk is never lost behind a long list. No clock but
 * the expiry filter's `now`.
 */
const boostFor = async (
  prisma: PrismaClient,
  member: {
    id: string;
    rewards?: Array<{ kind: string; detail: unknown; expiresAt: Date }>;
  },
  now: Date,
  listFull: boolean
): Promise<LoyaltyCard["boost"]> => {
  const referralPending = await isReferralPending(prisma, member.id);
  let perk: { id: string; expiresAt: Date } | null = null;

  if (!referralPending) {
    const open = (member.rewards ?? []).find(
      (r) => isDoublePointsPerk(r.kind, r.detail) && r.expiresAt.getTime() > now.getTime()
    );

    if (open) {
      perk = { id: "", expiresAt: open.expiresAt };
    } else if (listFull) {
      perk = await prisma.memberReward.findFirst({
        where: {
          memberId: member.id,
          kind: MemberRewardKind.VENTAJA,
          redeemedAt: null,
          expiresAt: { gt: now },
          detail: { path: ["perk"], equals: DOUBLE_PERK }
        },
        orderBy: [...PERK_ORDER],
        select: { id: true, expiresAt: true }
      });
    }
  }

  const decided = chooseDouble(referralPending, perk);

  if (!decided.applies || !decided.reason) return undefined;

  return decided.reason === "referral"
    ? { kind: "referral" }
    : { kind: "perk", until: decided.until ?? undefined };
};

/**
 * What the member shares to recommend the clinic: their own code and the public sign-up link that
 * carries it. Undefined (so the card has no `referral` at all) when the base URL, the clinic's slug
 * or a usable code is missing: a broken link on a card is worse than none.
 */
const referralFor = (
  signupBaseUrl: string | undefined,
  slug: string | null | undefined,
  code: string | null
): LoyaltyCard["referral"] => {
  const base = signupBaseUrl?.trim().replace(/\/+$/, "");

  if (!base || !slug || !code || !MEMBER_CODE_PATTERN.test(code)) return undefined;

  return {
    code,
    url: `${base}/alta/${encodeURIComponent(slug)}?ref=${encodeURIComponent(code)}`
  };
};

/** The key is left off the card altogether, not set to undefined, when there is no referral. */
const referralField = (
  referral: LoyaltyCard["referral"]
): { referral?: LoyaltyCard["referral"] } => (referral ? { referral } : {});

/** The most rewards a card shows; the pass only ever lists a handful and counts the rest. */
const AVAILABLE_REWARDS_LIMIT = 20;

export class PrismaLoyaltyCardAssembler implements LoyaltyCardAssembler {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redemptionSecret: string,
    private readonly now: () => Date = () => new Date(),
    /**
     * The public frontend's origin, for the referral link on the card (`config.FRONTEND_URL`).
     * Without it no card carries a referral.
     */
    private readonly signupBaseUrl?: string
  ) {}

  async assemble(memberId: string): Promise<LoyaltyCard> {
    const now = this.now();
    const member = await this.prisma.member.findUnique({
      where: { id: memberId },
      include: {
        // The rewards the member can redeem now, in the same round trip. Ordered with tie-breakers
        // because one visit issues its rewards with the same expiry, and the card must come out
        // byte-equal each time. Cheap for a clinic with no programme: the member has no rows.
        rewards: {
          where: { redeemedAt: null, expiresAt: { gt: now } },
          orderBy: [{ expiresAt: "asc" }, { issuedAt: "asc" }, { id: "asc" }],
          take: AVAILABLE_REWARDS_LIMIT,
          select: { title: true, kind: true, detail: true, expiresAt: true }
        },
        // The latest clinic message, in the same round trip for the same reason as the programme.
        walletMessage: true,
        clinic: {
          include: {
            template: true,
            // The live programme, if any, in the same round trip: a pass is rebuilt on every
            // sync and device fetch, so a second query here would be paid thousands of times.
            onboardingPrograms: {
              where: { status: OnboardingProgramStatus.ACTIVO },
              // Newest first, so the card is deterministic even if two ACTIVO programmes
              // ever exist (without an order the database may return either, and the
              // freshness re-check would see the card alternate between them).
              orderBy: { version: "desc" },
              take: 1,
              select: { output: true }
            }
          }
        }
      }
    });

    // An erased member is treated as absent rather than rendered: erasure overwrites the
    // row in place to keep foreign keys intact, so the row still exists but must not
    // produce a card.
    if (!member || member.erasedAt) {
      throw new MemberNotFoundError(memberId);
    }

    const template = member.clinic.template;

    if (!template) {
      throw new WalletConfigurationError(
        `Clinic ${member.clinic.id} has no template, so no card can be built for its members.`
      );
    }

    // The clinic's authored ladder, and where this member stands on it. Parsed rather
    // than trusted: a template written before tiers carried points yields a scale that
    // cannot rank anybody, and a card with no reward is better than one showing
    // progress against a tier the member is not in.
    const live = member.clinic.onboardingPrograms?.[0];

    // A clinic that has published a programme is ranked by it; every other clinic keeps the
    // ladder its template carries, exactly as before.
    const reward = live
      ? programRewardFor(live.output, member.lifetimePoints)
      : rewardFor(member, template.tierRewards);

    const card = {
      memberId: member.id,
      serialNumber: `voone-member-${member.id}`,
      redemptionCode: deriveRedemptionCode(member.id, this.redemptionSecret),
      tier: member.tier ?? undefined,
      clinic: { name: member.clinic.name },
      member: {
        fullName: member.name,
        code: member.code ?? undefined,
        memberSince: member.memberSince ? String(member.memberSince) : undefined
      },
      // A programme centre shows points (ten per euro); the ledger holds euro progress.
      points: live ? toPoints(member.pointsBalance) : member.pointsBalance,
      reward,
      // Only a programme centre issues rewards. Filtered here as well as in the query: the
      // clock is the caller's, and the card must never offer one that has lapsed. The double-points
      // perk is spent by the next payment and cannot be redeemed by hand, so it is not a gift.
      rewards: live
        ? {
            available: (member.rewards ?? [])
              .filter(
                (r) =>
                  r.expiresAt.getTime() > now.getTime() && !isDoublePointsPerk(r.kind, r.detail)
              )
              .map((r) => ({
                // A blank title would fail the schema and stop this member's card syncing at all.
                title: clipText(r.title.trim(), 120) || "Regalo",
                expiresAt: r.expiresAt.toISOString()
              }))
          }
        : undefined,
      // A pending x2, for a programme centre only.
      boost: live
        ? await boostFor(
            this.prisma,
            member,
            now,
            (member.rewards ?? []).length >= AVAILABLE_REWARDS_LIMIT
          )
        : undefined,
      // Referrals need an ACTIVO programme, so only a programme centre shows the share.
      ...(live
        ? referralField(referralFor(this.signupBaseUrl, member.clinic.slug, member.code))
        : {}),
      // The programme's benefits for the member's tier replace the hand-typed text on the pass.
      tierBenefits: live ? tierBenefitsFor(live.output, member.tier) : undefined,
      message: member.walletMessage ? { text: formatCardMessage(member.walletMessage) } : undefined,
      template: {
        programName: template.programName,
        backgroundColor: template.hexBackgroundColor,
        logoUrl: template.logoUrl ?? undefined,
        logoOnDarkUrl: template.logoOnDarkUrl ?? undefined,
        heroImageUrl: template.heroImageUrl ?? undefined,
        websiteUrl: template.websiteUrl ?? undefined,
        appointmentUrl: template.appointmentUrl ?? undefined,
        appLinkText: template.appLinkText ?? undefined,
        appLinkDescription: template.appLinkDescription ?? undefined,
        extraButtons: extraButtonsOf(template.extraButtons),
        pointsLabel: template.pointsLabel,
        tierLabel: template.tierLabel,
        // Clipped, not rejected: texts saved while the template schema still allowed 1200
        // characters must not stop every card of the clinic from syncing.
        benefitsText: template.benefitsText ? clipCardText(template.benefitsText) : undefined,
        infoText: template.infoText ? clipCardText(template.infoText) : undefined
      }
    };

    // Parsed rather than cast. The database columns are looser than the card allows —
    // a name longer than the pass field, say — and a card that fails validation must do
    // so here, where the clinic is named, rather than inside a provider's SDK.
    const parsed = loyaltyCardSchema.safeParse(card);

    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");

      throw new WalletConfigurationError(
        `Member ${memberId} cannot be rendered as a card: ${details}`
      );
    }

    return parsed.data;
  }
}
