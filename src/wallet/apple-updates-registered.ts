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
 * A member who never registered, or switched Automatic Updates off (iOS then deletes the
 * registration), has a card that stays as it was however many points they earn — and
 * staff had no way to see that.
 *
 *  - null:  nothing to say — no SYNCED Apple card, or Apple is not available here.
 *  - true:  the SYNCED card has at least one registered device.
 *  - false: the SYNCED card has none, so no update will reach a phone.
 *
 * One query for the whole list, and none at all when nobody has a card to look up.
 */
export const appleUpdatesRegisteredFor = async (
  devices: Pick<PassDeviceRepository, "registeredSerials">,
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

  const registered = await devices.registeredSerials(passTypeIdentifier, [
    ...new Set(serialByMember.values())
  ]);

  serialByMember.forEach((serial, memberId) => result.set(memberId, registered.has(serial)));

  return result;
};
