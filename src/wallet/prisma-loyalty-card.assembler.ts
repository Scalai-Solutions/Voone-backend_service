import type { PrismaClient } from "@prisma/client";

import { MemberNotFoundError } from "../common/errors/membership.errors";
import { WalletConfigurationError } from "../common/errors/wallet.errors";
import { LoyaltyCardAssembler } from "./engine/loyalty-card-assembler";
import { LoyaltyCard, loyaltyCardSchema } from "./engine/loyalty-card";
import { deriveRedemptionCode } from "./engine/redemption-code";

/**
 * Assembles a card from Member.pointsBalance.
 *
 * **Temporary, and only in its points source.** That column is written by nothing today,
 * so every card currently reports zero. When the points ledger lands, this class is
 * replaced by one that derives the balance — and the tier — from the ledger, and no
 * adapter changes: that swap is the entire reason LoyaltyCardAssembler is an interface.
 *
 * Everything else here is not temporary. The clinic, the template and the member's own
 * details come from the authoritative rows and will read the same way afterwards.
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
