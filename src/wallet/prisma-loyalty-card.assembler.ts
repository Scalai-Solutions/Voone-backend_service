import type { PrismaClient } from "@prisma/client";

import { MemberNotFoundError } from "../common/errors/membership.errors";
import { WalletConfigurationError } from "../common/errors/wallet.errors";
import { LoyaltyCardAssembler } from "./engine/loyalty-card-assembler";
import { LoyaltyCard, loyaltyCardSchema } from "./engine/loyalty-card";
import { deriveRedemptionCode } from "./engine/redemption-code";

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
export class PrismaLoyaltyCardAssembler implements LoyaltyCardAssembler {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redemptionSecret: string
  ) {}

  async assemble(memberId: string): Promise<LoyaltyCard> {
    const member = await this.prisma.member.findUnique({
      where: { id: memberId },
      include: { clinic: { include: { template: true } } }
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

    const card = {
      memberId: member.id,
      serialNumber: `voone-member-${member.id}`,
      redemptionCode: deriveRedemptionCode(member.id, this.redemptionSecret),
      tier: member.tier ?? undefined,
      clinic: { name: member.clinic.name },
      member: {
        fullName: member.name,
        memberSince: member.memberSince ? String(member.memberSince) : undefined
      },
      points: member.pointsBalance,
      template: {
        programName: template.programName,
        backgroundColor: template.hexBackgroundColor,
        logoUrl: template.logoUrl ?? undefined,
        heroImageUrl: template.heroImageUrl ?? undefined,
        websiteUrl: template.websiteUrl ?? undefined,
        appointmentUrl: template.appointmentUrl ?? undefined,
        appLinkText: template.appLinkText ?? undefined,
        appLinkDescription: template.appLinkDescription ?? undefined,
        pointsLabel: template.pointsLabel,
        tierLabel: template.tierLabel,
        benefitsText: template.benefitsText || undefined,
        infoText: template.infoText || undefined
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
