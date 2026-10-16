import { WalletProviderType, WalletSyncStatus, type PrismaClient } from "@prisma/client";

import { MemberNotFoundError } from "../../common/errors/membership.errors";
import { tierRewardsSchema } from "../templates/templates.schema";
import { normaliseScale } from "../points/tier-engine";

/** Mirrors the dashboard's own union. "unavailable" means the provider is not configured. */
export type ProviderStatus = "added" | "not_added" | "unavailable" | "failed";

export interface MemberSummary {
  id: string;
  name: string;
  /**
   * The five-character number printed on the member's card.
   *
   * Null for members who signed up before Member.code existed and have not been
   * backfilled. See scripts/backfill-member-codes.ts.
   */
  code: string | null;
  /** Phone if we have one, otherwise email. What reception uses to recognise someone. */
  identity: string;
  /** Carried separately from identity, which collapses to one of the two. */
  email: string | null;
  /** ISO date (YYYY-MM-DD) when captured by the current sign-up form. */
  birthDate: string | null;
  /** Fallback for older sign-ups that only captured a year. */
  birthYear: number | null;
  sex: string | null;
  templateId: string;
  templateName: string;
  points: number;
  moneySpent: number;
  lastVisitedAt: string | null;
  tier: string;
  walletStatus: Record<"apple" | "google", ProviderStatus>;
  history: Array<{ id: string; label: string; points: number; date: string }>;
}

export interface ListMembersOptions {
  clinicId: string;
  /** Matches name, phone or email. */
  query?: string;
  limit: number;
  offset: number;
}

/**
 * How many ledger rows a member summary carries.
 *
 * The list shows a few recent movements per member; the detail view shows the same field
 * with more. Bounded either way — a member with years of visits must not turn one list
 * request into thousands of rows.
 */
const LIST_HISTORY = 3;
const DETAIL_HISTORY = 50;

type SpendingStats = { moneySpent: number; lastVisitedAt: string | null };

const splitTreatmentNames = (reason: string | null): string[] =>
  reason
    ? reason
        .split(" + ")
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean)
    : [];

const statusFor = (
  row: { status: WalletSyncStatus } | undefined,
  configured: boolean
): ProviderStatus => {
  // "unavailable" is about US, not the member: the provider is not configured, so no
  // member could have a card with it. Reporting "not_added" would invite staff to keep
  // asking a member to add one.
  if (!configured) return "unavailable";
  if (!row) return "not_added";
  if (row.status === WalletSyncStatus.FAILED) return "failed";
  if (row.status === WalletSyncStatus.SYNCED) return "added";

  // PENDING: issued but not yet confirmed with the provider.
  return "not_added";
};

const baseTierFromTemplate = (tierRewards: unknown): string => {
  const parsed = tierRewardsSchema.safeParse(tierRewards ?? []);

  if (!parsed.success) return "";

  try {
    return (
      normaliseScale(
        parsed.data.map((tier) => ({
          code: tier.name,
          label: tier.name,
          minLifetimePoints: tier.minLifetimePoints
        }))
      )[0]?.code ?? ""
    );
  } catch {
    return "";
  }
};

export class MemberDirectoryService {
  constructor(
    private readonly prisma: PrismaClient,
    /** Which providers the registry actually accepted, so "unavailable" is truthful. */
    private readonly configured: () => Set<WalletProviderType>
  ) {}

  async list(options: ListMembersOptions): Promise<MemberSummary[]> {
    const q = options.query?.trim();

    const members = await this.prisma.member.findMany({
      where: {
        clinicId: options.clinicId,
        // An erased member is not a member. The row survives only to keep the ledger's
        // foreign keys intact.
        erasedAt: null,
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" as const } },
                // The number on the member's card. Matched exactly rather than by
                // substring, and case-insensitively because the code is printed
                // uppercase and nobody types it that way: five characters are short
                // enough that `contains` would make "K7M2Q" match on fragments of
                // unrelated codes, which is the opposite of what a reception desk needs.
                { code: { equals: q, mode: "insensitive" as const } },
                { phone: { contains: q } },
                { email: { contains: q, mode: "insensitive" as const } }
              ]
            }
          : {})
      },
      orderBy: { createdAt: "desc" },
      take: options.limit,
      skip: options.offset,
      select: this.selection(LIST_HISTORY)
    });

    return this.withSpendingStats(
      members.map((member) => this.toSummary(member)),
      options.clinicId
    );
  }

  async get(memberId: string): Promise<MemberSummary> {
    const member = await this.prisma.member.findUnique({
      where: { id: memberId },
      select: this.selection(DETAIL_HISTORY)
    });

    if (!member || member.erasedAt) {
      throw new MemberNotFoundError(memberId);
    }

    const [summary] = await this.withSpendingStats([this.toSummary(member)], member.clinicId);

    return summary;
  }

  private selection(historyTake: number) {
    return {
      id: true,
      name: true,
      code: true,
      phone: true,
      email: true,
      birthDate: true,
      birthYear: true,
      sex: true,
      clinicId: true,
      pointsBalance: true,
      tier: true,
      erasedAt: true,
      clinic: {
        select: { template: { select: { id: true, programName: true, tierRewards: true } } }
      },
      walletObjects: { select: { provider: true, status: true } },
      pointsLedger: {
        orderBy: { createdAt: "desc" as const },
        take: historyTake,
        select: { id: true, points: true, kind: true, reason: true, createdAt: true }
      }
    };
  }

  private toSummary(member: {
    id: string;
    name: string;
    code: string | null;
    phone: string | null;
    email: string | null;
    birthDate: Date | null;
    birthYear: number | null;
    sex: string | null;
    clinicId: string;
    pointsBalance: number;
    tier: string | null;
    clinic: { template: { id: string; programName: string; tierRewards: unknown } | null };
    walletObjects: Array<{ provider: WalletProviderType; status: WalletSyncStatus }>;
    pointsLedger: Array<{
      id: string;
      points: number;
      kind: string;
      reason: string | null;
      createdAt: Date;
    }>;
  }): MemberSummary {
    const configured = this.configured();
    const apple = member.walletObjects.find((w) => w.provider === WalletProviderType.APPLE);
    const google = member.walletObjects.find((w) => w.provider === WalletProviderType.GOOGLE);

    return {
      id: member.id,
      name: member.name,
      // The number on the member's card, which is what reception asks for out loud.
      // Null for anyone the backfill has not reached — rendered as absent rather than
      // substituted, because an identifier that is sometimes a different kind of thing
      // is worse than one that is sometimes missing.
      code: member.code,
      identity: member.phone ?? member.email ?? "",
      email: member.email,
      birthDate: member.birthDate?.toISOString().slice(0, 10) ?? null,
      birthYear: member.birthYear,
      sex: member.sex,
      // A clinic with no template yet is a real state — it is provisioned before its card
      // is designed — so this reports empty rather than refusing to list the member.
      templateId: member.clinic.template?.id ?? "",
      templateName: member.clinic.template?.programName ?? "",
      points: member.pointsBalance,
      moneySpent: 0,
      lastVisitedAt: null,
      tier: member.tier ?? baseTierFromTemplate(member.clinic.template?.tierRewards),
      walletStatus: {
        apple: statusFor(apple, configured.has(WalletProviderType.APPLE)),
        google: statusFor(google, configured.has(WalletProviderType.GOOGLE))
      },
      history: member.pointsLedger.map((row) => ({
        id: row.id,
        // reason is staff-authored and optional; the kind is the honest fallback and is
        // never a treatment name.
        label: row.reason ?? row.kind,
        points: row.points,
        date: row.createdAt.toISOString().slice(0, 10)
      }))
    };
  }

  private async withSpendingStats(
    summaries: MemberSummary[],
    clinicId: string
  ): Promise<MemberSummary[]> {
    if (summaries.length === 0) return summaries;

    const [treatments, credits] = await Promise.all([
      this.prisma.clinicTreatment.findMany({
        where: { clinicId },
        select: { name: true, priceEuro: true }
      }),
      this.prisma.pointsTransaction.findMany({
        where: {
          clinicId,
          memberId: { in: summaries.map((member) => member.id) },
          points: { gt: 0 }
        },
        orderBy: { createdAt: "desc" },
        select: { memberId: true, reason: true, createdAt: true }
      })
    ]);

    const prices = new Map(
      treatments
        .filter((treatment) => treatment.priceEuro !== null)
        .map((treatment) => [treatment.name.trim().toLowerCase(), treatment.priceEuro ?? 0])
    );
    const stats = new Map<string, SpendingStats>();

    for (const credit of credits) {
      const current = stats.get(credit.memberId) ?? { moneySpent: 0, lastVisitedAt: null };

      current.lastVisitedAt ??= credit.createdAt.toISOString();
      current.moneySpent += splitTreatmentNames(credit.reason).reduce(
        (total, name) => total + (prices.get(name) ?? 0),
        0
      );
      stats.set(credit.memberId, current);
    }

    return summaries.map((summary) => ({
      ...summary,
      ...(stats.get(summary.id) ?? { moneySpent: 0, lastVisitedAt: null })
    }));
  }
}
