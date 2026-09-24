import { WalletProviderType, type PrismaClient } from "@prisma/client";

import { DeviceRegistration } from "./engine/pass-device-registry.interface";
import { PassDeviceRepository, PassRecord } from "./engine/pass-device.repository";

export class PrismaPassDeviceRepository implements PassDeviceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async saveRegistration(
    registration: Required<DeviceRegistration>
  ): Promise<{ created: boolean }> {
    const existing = await this.prisma.passDeviceRegistration.findUnique({
      where: {
        deviceLibraryIdentifier_passTypeIdentifier_serialNumber: {
          deviceLibraryIdentifier: registration.deviceLibraryIdentifier,
          passTypeIdentifier: registration.passTypeIdentifier,
          serialNumber: registration.serialNumber
        }
      },
      select: { id: true }
    });

    await this.prisma.passDeviceRegistration.upsert({
      where: {
        deviceLibraryIdentifier_passTypeIdentifier_serialNumber: {
          deviceLibraryIdentifier: registration.deviceLibraryIdentifier,
          passTypeIdentifier: registration.passTypeIdentifier,
          serialNumber: registration.serialNumber
        }
      },
      // A re-register carries a rotated push token, which is the whole reason Apple
      // repeats the call. Replace it rather than ignoring the write.
      // Only the push token moves. The rest of the row is the key.
      update: { pushToken: registration.pushToken },
      create: registration
    });

    return { created: !existing };
  }

  async removeRegistration(
    deviceLibraryIdentifier: string,
    passTypeIdentifier: string,
    serialNumber: string
  ): Promise<boolean> {
    const { count } = await this.prisma.passDeviceRegistration.deleteMany({
      where: { deviceLibraryIdentifier, passTypeIdentifier, serialNumber }
    });

    return count > 0;
  }

  async serialsUpdatedSince(
    deviceLibraryIdentifier: string,
    passTypeIdentifier: string,
    since?: Date
  ): Promise<{ serialNumbers: string[]; lastUpdated: Date | null }> {
    const registrations = await this.prisma.passDeviceRegistration.findMany({
      where: { deviceLibraryIdentifier, passTypeIdentifier },
      select: { serialNumber: true }
    });

    if (registrations.length === 0) {
      return { serialNumbers: [], lastUpdated: null };
    }

    // The change time lives on WalletObject, not on the registration: a pass changes
    // because its card was re-synced, which is a fact about the pass and not about any
    // one device holding it.
    const objects = await this.prisma.walletObject.findMany({
      where: {
        provider: WalletProviderType.APPLE,
        externalObjectId: { in: registrations.map((r) => r.serialNumber) },
        ...(since ? { lastSyncedAt: { gt: since } } : { lastSyncedAt: { not: null } })
      },
      select: { externalObjectId: true, lastSyncedAt: true },
      orderBy: { lastSyncedAt: "desc" }
    });

    return {
      serialNumbers: objects.map((o) => o.externalObjectId),
      lastUpdated: objects[0]?.lastSyncedAt ?? null
    };
  }

  async pushTokensFor(passTypeIdentifier: string, serialNumber: string): Promise<string[]> {
    const rows = await this.prisma.passDeviceRegistration.findMany({
      where: { passTypeIdentifier, serialNumber },
      select: { pushToken: true }
    });

    return rows.map((row) => row.pushToken);
  }

  async authenticationTokenFor(
    passTypeIdentifier: string,
    serialNumber: string
  ): Promise<string | null> {
    const credential = await this.prisma.applePassCredential.findUnique({
      where: { passTypeIdentifier_serialNumber: { passTypeIdentifier, serialNumber } },
      select: { authenticationToken: true }
    });

    return credential?.authenticationToken ?? null;
  }

  async passRecordFor(
    passTypeIdentifier: string,
    serialNumber: string
  ): Promise<PassRecord | null> {
    // WalletObject tracks the member's current card and is not pass-type scoped, so the
    // credential is what proves this serial belongs to the pass type being asked about.
    const credential = await this.prisma.applePassCredential.findUnique({
      where: { passTypeIdentifier_serialNumber: { passTypeIdentifier, serialNumber } },
      select: { serialNumber: true }
    });

    if (!credential) return null;

    const object = await this.prisma.walletObject.findFirst({
      where: { provider: WalletProviderType.APPLE, externalObjectId: serialNumber },
      select: { memberId: true, lastSyncedAt: true, createdAt: true }
    });

    if (!object) return null;

    // Falls back to when the pass was issued: a pass that has never been synced has still
    // been modified once, and reporting null there would defeat caching entirely.
    return { memberId: object.memberId, lastUpdated: object.lastSyncedAt ?? object.createdAt };
  }

  async setAuthenticationToken(
    passTypeIdentifier: string,
    serialNumber: string,
    token: string
  ): Promise<void> {
    await this.prisma.applePassCredential.upsert({
      where: { passTypeIdentifier_serialNumber: { passTypeIdentifier, serialNumber } },
      update: { authenticationToken: token },
      create: { passTypeIdentifier, serialNumber, authenticationToken: token }
    });
  }
}
