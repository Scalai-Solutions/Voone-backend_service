import { WalletProviderType, WalletSyncStatus } from "@prisma/client";

import { getAppleWalletConfig, isAppleWalletConfigured } from "../config/apple-wallet.config";
import type { PassDeviceRepository } from "./engine/pass-device.repository";

/**
 * The pass type this deployment issues under, or null when Apple is not usable here.
 *
 * Read from the cached certificate config, so it costs nothing per request. A config that
 * throws is reported as null rather than failing a members list that needs no wallet.
 */
export const applePassTypeIdentifier = (): string | null => {
  try {
    return isAppleWalletConfigured() ? getAppleWalletConfig().passTypeIdentifier : null;
  } catch {
    return null;
  }
};

interface MemberWithWalletObjects {
  id: string;
  walletObjects: ReadonlyArray<{
    provider: WalletProviderType;
    status: WalletSyncStatus;
    externalObjectId: string;
  }>;
}

/**
 * Whether each member's Apple card has a phone registered to be told about changes.
 *
 * An Apple card updates only when the server pushes to a phone that registered for it.
 * A member who switched Automatic Updates off (iOS then deletes the registration) has a
 * card that stays as it was however many points they earn, and staff had no way to see it.
 *
 * A SYNCED Apple object is NOT proof the card is installed: it is recorded when the pass
 * is ISSUED, so every Android member, and every iPhone member who never tapped Add, has
 * one. `false` therefore needs evidence the card reached a phone.
 *
 *  - true:  at least one registration row exists.
 *  - false: no registration row AND the credential shows the pass was downloaded or a
 *           phone registered at some point (both outlive the registration row).
 *  - null:  no SYNCED Apple card, Apple unavailable, or no evidence either way.
 *
 * Deliberate limitation: the evidence columns only fill in from when they shipped, so
 * every existing member reads null until they next download the pass or register a phone.
 * An honest "unknown" beats flagging the whole membership as broken.
 *
 * At most two queries for the whole list, and none when nobody has a card to look up.
 */
export const appleUpdatesRegisteredFor = async (
  devices: Pick<PassDeviceRepository, "installState">,
  passTypeIdentifier: string | null,
  members: ReadonlyArray<MemberWithWalletObjects>
): Promise<Map<string, boolean | null>> => {
  const result = new Map<string, boolean | null>();
  const serialByMember = new Map<string, string>();

  for (const member of members) {
    result.set(member.id, null);

    const card = member.walletObjects.find(
      (object) =>
        object.provider === WalletProviderType.APPLE && object.status === WalletSyncStatus.SYNCED
    );

    if (card) serialByMember.set(member.id, card.externalObjectId);
  }

  if (passTypeIdentifier === null || serialByMember.size === 0) return result;

  const { registered, evidenced } = await devices.installState(passTypeIdentifier, [
    ...new Set(serialByMember.values())
  ]);

  serialByMember.forEach((serial, memberId) => {
    if (registered.has(serial)) result.set(memberId, true);
    else if (evidenced.has(serial)) result.set(memberId, false);
  });

  return result;
};

/**
 * Note that a pass was just handed to a person, for the evidence above.
 *
 * Best effort: the member is waiting for their card, and a failed bookkeeping write must
 * never cost them it. Apple unavailable is a no-op.
 */
export const recordAppleDownload = async (
  devices: Pick<PassDeviceRepository, "markDownloadedForMember">,
  memberId: string
): Promise<void> => {
  const passTypeIdentifier = applePassTypeIdentifier();

  if (passTypeIdentifier === null) return;

  try {
    await devices.markDownloadedForMember(passTypeIdentifier, memberId);
  } catch (error) {
    console.warn(
      `[apple-wallet] could not record the download for member ${memberId}:`,
      error instanceof Error ? error.message : error
    );
  }
};
