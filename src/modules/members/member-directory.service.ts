import {
  OnboardingProgramStatus,
  WalletProviderType,
  WalletSyncStatus,
  type PrismaClient
} from "@prisma/client";

import { MemberNotFoundError, MemberPhoneTakenError } from "../../common/errors/membership.errors";
import type { MemberUpdateInput } from "./membership.schema";
import { toPoints } from "../onboarding/runtime/points-unit";
import { listTreatments } from "../treatments/treatment-catalogue.service";
import type { CardRef } from "../../wallet/engine/wallet-pass-provider.interface";
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
  /** Canonical E.164, so the edit form prefills what is stored rather than a guess. */
  phone: string | null;
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

export interface DeleteMemberOptions {
  clinicId: string;
  memberId: string;
  revokeCard: (ref: CardRef) => Promise<boolean>;
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

  /**
   * Edit a member's own details: name, phone, email, date of birth, sex. Each field is
   * absent-means-unchanged; the pipelines (name cleaning, phone normalisation, the 16-plus
   * gate) are the sign-up ones, so the two surfaces cannot drift.
   *
   * A phone that another member of the clinic already holds is a 409, not a silent second
   * row: the phone is the identity. When the name or phone changes, the wallet pass is
   * re-synced — the card carries both.
   */
  async update(options: {
    clinicId: string;
    memberId: string;
    patch: MemberUpdateInput;
    syncMemberCard: (memberId: string) => void;
  }): Promise<MemberSummary> {
    const member = await this.prisma.member.findFirst({
      where: { id: options.memberId, clinicId: options.clinicId, erasedAt: null },
      select: { id: true }
    });

    if (!member) throw new MemberNotFoundError(options.memberId);

    const patch = options.patch;

    if (patch.phone) {
      const clash = await this.prisma.member.findFirst({
        where: {
          clinicId: options.clinicId,
          phone: patch.phone.e164,
          id: { not: member.id },
          erasedAt: null
        },
        select: { id: true }
      });

      if (clash) throw new MemberPhoneTakenError();
    }

    await this.prisma.member.update({
      where: { id: member.id },
      data: {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.phone !== undefined && {
          phone: patch.phone?.e164 ?? null,
          phoneRaw: patch.phone?.raw ?? null,
          phoneRegionAssumed: patch.phone?.regionAssumed ?? false
        }),
        ...(patch.email !== undefined && { email: patch.email ?? null }),
        ...(patch.birthDate !== undefined && {
          birthDate: patch.birthDate ?? null,
          // The same fallback the sign-up writes, so the dashboard's age column keeps
          // working for a member whose date was cleared or replaced.
          birthYear: patch.birthDate ? patch.birthDate.getUTCFullYear() : null
        }),
        ...(patch.sex !== undefined && { sex: patch.sex ?? null })
      }
    });

    // The pass carries the name, and the phone is what reception reads out. A change to
    // either must reach the wallet or the card stops matching what the desk sees.
    if (patch.name !== undefined || patch.phone !== undefined) {
      options.syncMemberCard(member.id);
    }

    return this.get(member.id);
  }

  async delete(options: DeleteMemberOptions): Promise<void> {
    const member = await this.prisma.member.findFirst({
      where: { id: options.memberId, clinicId: options.clinicId, erasedAt: null },
      select: {
        id: true,
        walletObjects: { select: { provider: true, externalObjectId: true } }
      }
    });

    if (!member) {
      throw new MemberNotFoundError(options.memberId);
    }

    for (const object of member.walletObjects) {
      const revoked = await options.revokeCard({
        provider: object.provider,
        externalId: object.externalObjectId,
        memberId: member.id
      });

      if (!revoked) {
        console.warn("[members] wallet provider unavailable during member deletion", {
          memberId: member.id,
          provider: object.provider
        });
      }
    }

    const now = new Date();

    // The member's bonos go too: they hold treatment names, which is exactly the data
    // erasure must remove. The visits that consumed them survive with amounts only.
    const [, , , updated] = await this.prisma.$transaction([
      this.prisma.memberBono.deleteMany({ where: { memberId: member.id } }),
      this.prisma.passClaim.deleteMany({ where: { memberId: member.id } }),
      this.prisma.walletObject.deleteMany({ where: { memberId: member.id } }),
      this.prisma.member.updateMany({
        where: { id: member.id, clinicId: options.clinicId, erasedAt: null },
        data: {
          erasedAt: now,
          name: "Miembro eliminado",
          phone: null,
          email: null,
          code: null,
          pointsBalance: 0,
          lifetimePoints: 0,
          tier: null,
          phoneRaw: null,
          phoneRegionAssumed: false,
          memberSince: null,
          birthYear: null,
          birthDate: null,
          sex: null,
          consentMarketing: false,
          consentMarketingAt: null,
          privacyPolicyVersion: null,
          signupCount: 0,
          lastSignupAt: now
        }
      })
    ]);

    if (updated.count === 0) {
      throw new MemberNotFoundError(options.memberId);
    }
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
      phone: member.phone,
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
      // The same source as the scan screen, so a programme centre's prices come from its
      // catalogue rather than a ClinicTreatment list nothing keeps up to date.
      listTreatments(this.prisma, clinicId),
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
    const programme = await this.programmeSpending(
      clinicId,
      summaries.map((member) => member.id)
    );

    // A centre with a live programme: points are ten per euro of progress, and the money spent is
    // what its recorded visits paid. The treatment-name matching below is the older scheme.
    if (programme) {
      return summaries.map((summary) => ({
        ...summary,
        points: toPoints(summary.points),
        history: summary.history.map((row) => ({ ...row, points: toPoints(row.points) })),
        ...(programme.get(summary.id) ?? { moneySpent: 0, lastVisitedAt: null })
      }));
    }

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

  /**
   * Euros paid and the last visit, per member, for a centre running a programme; null when it
   * has none. Taken from recorded visits, which hold the amount, rather than from ledger reasons.
   */
  private async programmeSpending(
    clinicId: string,
    memberIds: string[]
  ): Promise<Map<string, SpendingStats> | null> {
    const live = await this.prisma.onboardingProgram.findFirst({
      where: { clinicId, status: OnboardingProgramStatus.ACTIVO },
      select: { id: true }
    });

    if (!live) return null;

    const rows = await this.prisma.paidVisit.groupBy({
      by: ["memberId"],
      where: { clinicId, memberId: { in: memberIds } },
      _sum: { amountCents: true },
      _max: { occurredAt: true }
    });

    return new Map(
      rows.map((row) => [
        row.memberId,
        {
          moneySpent: (row._sum.amountCents ?? 0) / 100,
          lastVisitedAt: row._max.occurredAt?.toISOString() ?? null
        }
      ])
    );
  }
}
