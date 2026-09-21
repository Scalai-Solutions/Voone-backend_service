import { WalletProviderType, WalletSyncStatus, type PrismaClient } from "@prisma/client";

import { CardRef, ProgramRef } from "./engine/wallet-pass-provider.interface";
import { WalletSyncRepository } from "./engine/wallet-sync.repository";

/**
 * WalletObject and WalletClass rows, behind the engine's port.
 *
 * The rows are the engine's memory of provider-side state, never the source of truth for
 * what a card says — that is always the LoyaltyCard assembled from the ledger.
 */
export class PrismaWalletSyncRepository implements WalletSyncRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findCard(memberId: string, provider: WalletProviderType): Promise<CardRef | null> {
    const object = await this.prisma.walletObject.findUnique({
      where: { memberId_provider: { memberId, provider } },
      select: { externalObjectId: true }
    });

    return object ? { provider, externalId: object.externalObjectId, memberId } : null;
  }

  async recordCard(ref: CardRef): Promise<void> {
    await this.prisma.walletObject.upsert({
      where: { memberId_provider: { memberId: ref.memberId, provider: ref.provider } },
      update: {
        externalObjectId: ref.externalId,
        status: WalletSyncStatus.SYNCED,
        lastSyncedAt: new Date()
      },
      create: {
        memberId: ref.memberId,
        provider: ref.provider,
        externalObjectId: ref.externalId,
        status: WalletSyncStatus.SYNCED,
        lastSyncedAt: new Date()
      }
    });
  }

  async markSynced(ref: CardRef): Promise<void> {
    await this.prisma.walletObject.updateMany({
      where: { memberId: ref.memberId, provider: ref.provider },
      // lastSyncedAt is what the pass web service reports as Last-Modified, so it has to
      // move on every successful sync or devices keep serving a cached pass.
      data: { status: WalletSyncStatus.SYNCED, lastSyncedAt: new Date() }
    });
  }

  async markFailed(ref: CardRef, cause: unknown): Promise<void> {
    // The cause is logged, not stored: there is no column for it, and provider payloads
    // have been known to echo member data back.
    console.error(`[wallet] ${ref.provider} sync failed for ${ref.externalId}:`, cause);

    await this.prisma.walletObject.updateMany({
      where: { memberId: ref.memberId, provider: ref.provider },
      // lastSyncedAt is deliberately untouched: it records the last state a device
      // actually received, and moving it on a failure would tell devices they are current
      // when they are not.
      data: { status: WalletSyncStatus.FAILED }
    });
  }

  async forgetCard(ref: CardRef): Promise<void> {
    await this.prisma.walletObject.deleteMany({
      where: { memberId: ref.memberId, provider: ref.provider }
    });
  }

  async findProgram(templateId: string, provider: WalletProviderType): Promise<ProgramRef | null> {
    const walletClass = await this.prisma.walletClass.findUnique({
      where: { clinicTemplateId_provider: { clinicTemplateId: templateId, provider } },
      select: { externalClassId: true }
    });

    return walletClass ? { provider, externalId: walletClass.externalClassId } : null;
  }

  async recordProgram(templateId: string, ref: ProgramRef): Promise<void> {
    await this.prisma.walletClass.upsert({
      where: {
        clinicTemplateId_provider: { clinicTemplateId: templateId, provider: ref.provider }
      },
      update: {
        externalClassId: ref.externalId,
        status: WalletSyncStatus.SYNCED,
        lastSyncedAt: new Date()
      },
      create: {
        clinicTemplateId: templateId,
        provider: ref.provider,
        externalClassId: ref.externalId,
        status: WalletSyncStatus.SYNCED,
        lastSyncedAt: new Date()
      }
    });
  }
}
