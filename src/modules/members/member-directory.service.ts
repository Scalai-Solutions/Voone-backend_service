import { WalletProviderType, WalletSyncStatus, type PrismaClient } from "@prisma/client";

import { MemberNotFoundError } from "../../common/errors/membership.errors";

/** Mirrors the dashboard's own union. "unavailable" means the provider is not configured. */
export type ProviderStatus = "added" | "not_added" | "unavailable" | "failed";

export interface MemberSummary {
  id: string;
  name: string;
  /** Phone if we have one, otherwise email. What reception uses to recognise someone. */
  identity: string;
  templateId: string;
  templateName: string;
  points: number;
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

    return members.map((member) => this.toSummary(member));
  }

  async get(memberId: string): Promise<MemberSummary> {
    const member = await this.prisma.member.findUnique({
      where: { id: memberId },
      select: this.selection(DETAIL_HISTORY)
    });

    if (!member || member.erasedAt) {
      throw new MemberNotFoundError(memberId);
    }

    return this.toSummary(member);
  }

  private selection(historyTake: number) {
    return {
      id: true,
      name: true,
      phone: true,
      email: true,
      pointsBalance: true,
      tier: true,
      erasedAt: true,
      clinic: { select: { template: { select: { id: true, programName: true } } } },
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
    phone: string | null;
    email: string | null;
    pointsBalance: number;
    tier: string | null;
    clinic: { template: { id: string; programName: string } | null };
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
      identity: member.phone ?? member.email ?? "",
      // A clinic with no template yet is a real state — it is provisioned before its card
      // is designed — so this reports empty rather than refusing to list the member.
      templateId: member.clinic.template?.id ?? "",
      templateName: member.clinic.template?.programName ?? "",
      points: member.pointsBalance,
      tier: member.tier ?? "",
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
}
