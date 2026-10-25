import { Prisma, PrismaClient, WalletProviderType, WalletSyncStatus } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { getRefreshStatus } from "../../src/modules/wallet-refresh/refresh-status";

/**
 * Against the local database, inside a transaction that is always rolled back, so the data
 * is left exactly as it was found.
 */
const db = new PrismaClient();

class Rollback extends Error {}

afterAll(async () => {
  await db.$disconnect();
});

const inRolledBackTransaction = async (
  work: (tx: Prisma.TransactionClient, clinicId: string) => Promise<void>
) => {
  await db
    .$transaction(async (tx) => {
      const clinic = await tx.clinic.create({
        data: {
          name: "Refresh status",
          addressLine: "Calle Prueba 1",
          pincode: "28001",
          slug: `refresh-status-${Date.now()}-${Math.round(Math.random() * 1e6)}`
        }
      });

      await work(tx, clinic.id);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
};

const addMember = async (
  tx: Prisma.TransactionClient,
  clinicId: string,
  label: string,
  objects: Array<{
    provider: WalletProviderType;
    status: WalletSyncStatus;
    lastSyncedAt: Date | null;
  }>,
  erasedAt: Date | null = null
) =>
  tx.member.create({
    data: {
      clinicId,
      name: label,
      consentMarketing: false,
      consentSource: "test",
      erasedAt,
      walletObjects: {
        create: objects.map((object) => ({
          ...object,
          externalObjectId: `${label}-${object.provider}`
        }))
      }
    }
  });

const T0 = new Date("2026-10-26T10:00:00.000Z");
const BEFORE = new Date("2026-10-26T09:00:00.000Z");
const AFTER = new Date("2026-10-26T11:00:00.000Z");

describe("getRefreshStatus", () => {
  it("reports no change and zero counts when none was recorded, but still counts who is eligible", async () => {
    await inRolledBackTransaction(async (tx, clinicId) => {
      await addMember(tx, clinicId, "a", [
        {
          provider: WalletProviderType.GOOGLE,
          status: WalletSyncStatus.SYNCED,
          lastSyncedAt: AFTER
        }
      ]);
      await addMember(tx, clinicId, "b", [
        { provider: WalletProviderType.APPLE, status: WalletSyncStatus.FAILED, lastSyncedAt: null }
      ]);

      expect(await getRefreshStatus(clinicId, tx)).toEqual({
        eligible: 2,
        lastChange: null,
        syncedSince: 0,
        failedSince: 0
      });
    });
  });

  it("follows object status and time after a recorded change", async () => {
    await inRolledBackTransaction(async (tx, clinicId) => {
      await tx.templateChange.create({
        data: {
          clinicId,
          templateId: "t-old",
          changedBy: "old@clinic.test",
          changedFields: ["programName"],
          cardsAtSave: 1,
          createdAt: BEFORE
        }
      });
      await tx.templateChange.create({
        data: {
          clinicId,
          templateId: "t-1",
          changedBy: "staff@clinic.test",
          changedFields: ["logoUrl"],
          cardsAtSave: 4,
          createdAt: T0
        }
      });
      // Another clinic's newer change must not leak in.
      const other = await tx.clinic.create({
        data: { name: "Other", addressLine: "x", pincode: "1", slug: `other-${Date.now()}` }
      });
      await tx.templateChange.create({
        data: {
          clinicId: other.id,
          templateId: "t-x",
          changedBy: "other@clinic.test",
          changedFields: ["logoUrl"],
          cardsAtSave: 9,
          createdAt: AFTER
        }
      });

      // Synced after the change: counts, one per object.
      await addMember(tx, clinicId, "synced-after", [
        {
          provider: WalletProviderType.GOOGLE,
          status: WalletSyncStatus.SYNCED,
          lastSyncedAt: AFTER
        },
        { provider: WalletProviderType.APPLE, status: WalletSyncStatus.SYNCED, lastSyncedAt: T0 }
      ]);
      // Synced before the change: has not received it yet.
      await addMember(tx, clinicId, "synced-before", [
        {
          provider: WalletProviderType.GOOGLE,
          status: WalletSyncStatus.SYNCED,
          lastSyncedAt: BEFORE
        }
      ]);
      // A failed sync leaves lastSyncedAt on the last good state, so a failure is counted
      // whatever that old date is.
      await addMember(tx, clinicId, "failed", [
        {
          provider: WalletProviderType.GOOGLE,
          status: WalletSyncStatus.FAILED,
          lastSyncedAt: BEFORE
        }
      ]);
      await addMember(tx, clinicId, "failed-never", [
        { provider: WalletProviderType.APPLE, status: WalletSyncStatus.FAILED, lastSyncedAt: null }
      ]);
      await addMember(tx, clinicId, "pending", [
        {
          provider: WalletProviderType.GOOGLE,
          status: WalletSyncStatus.PENDING,
          lastSyncedAt: null
        }
      ]);
      // No pass, and an erased member: neither is eligible nor counted.
      await addMember(tx, clinicId, "no-pass", []);
      await addMember(
        tx,
        clinicId,
        "erased",
        [
          {
            provider: WalletProviderType.GOOGLE,
            status: WalletSyncStatus.SYNCED,
            lastSyncedAt: AFTER
          }
        ],
        AFTER
      );

      expect(await getRefreshStatus(clinicId, tx)).toEqual({
        eligible: 5,
        lastChange: { at: T0.toISOString(), by: "staff@clinic.test", cardsAtSave: 4 },
        syncedSince: 2,
        failedSince: 2
      });
    });
  });

  it("reports by as null when the change had no signed-in user", async () => {
    await inRolledBackTransaction(async (tx, clinicId) => {
      await tx.templateChange.create({
        data: { clinicId, templateId: "t-1", changedFields: [], cardsAtSave: 0, createdAt: T0 }
      });

      expect((await getRefreshStatus(clinicId, tx)).lastChange).toEqual({
        at: T0.toISOString(),
        by: null,
        cardsAtSave: 0
      });
    });
  });
});
