import { WalletProviderType, WalletSyncStatus, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MemberDirectoryService } from "../../src/modules/members/member-directory.service";

/**
 * An Apple card only updates when a phone registered for it. These pin what the member
 * summary says about that, so staff can tell "the card is stale because no phone will
 * ever be told" from "the card is fine".
 */
const PASS_TYPE = "pass.ai.voone.giftcard";

type WalletObjectRow = {
  provider: WalletProviderType;
  status: WalletSyncStatus;
  externalObjectId: string;
};

const apple = (serial: string, status: WalletSyncStatus = WalletSyncStatus.SYNCED) => ({
  provider: WalletProviderType.APPLE,
  status,
  externalObjectId: serial
});

const google = (serial: string) => ({
  provider: WalletProviderType.GOOGLE,
  status: WalletSyncStatus.SYNCED,
  externalObjectId: serial
});

const memberRow = (id: string, walletObjects: WalletObjectRow[]) => ({
  id,
  name: `Member ${id}`,
  code: null,
  phone: null,
  email: null,
  birthDate: null,
  birthYear: null,
  sex: null,
  clinicId: "c-1",
  pointsBalance: 0,
  tier: "Bronce",
  erasedAt: null,
  clinic: { template: { id: "t", programName: "Club", tierRewards: [] } },
  walletObjects,
  pointsLedger: []
});

interface Registration {
  passTypeIdentifier: string;
  serialNumber: string;
}

const serviceFor = (
  members: ReturnType<typeof memberRow>[],
  registrations: Registration[],
  options: { configured?: WalletProviderType[]; passType?: string | null } = {}
) => {
  const registrationsFindMany = vi.fn(
    async (args: { where: { passTypeIdentifier?: string; serialNumber: { in: string[] } } }) =>
      registrations
        .filter(
          (row) =>
            (args.where.passTypeIdentifier === undefined ||
              row.passTypeIdentifier === args.where.passTypeIdentifier) &&
            args.where.serialNumber.in.includes(row.serialNumber)
        )
        .map((row) => ({ serialNumber: row.serialNumber }))
  );

  const prisma = {
    member: { findMany: async () => members, findUnique: async () => members[0] },
    catalogItem: { count: async () => 0, findMany: async () => [] },
    clinicTreatment: { findMany: async () => [] },
    pointsTransaction: { findMany: async () => [] },
    onboardingProgram: { findFirst: async () => null },
    passDeviceRegistration: { findMany: registrationsFindMany }
  } as unknown as PrismaClient;

  const service = new MemberDirectoryService(
    prisma,
    () => new Set(options.configured ?? [WalletProviderType.APPLE, WalletProviderType.GOOGLE]),
    () => (options.passType === undefined ? PASS_TYPE : options.passType)
  );

  return { service, registrationsFindMany };
};

const list = (service: MemberDirectoryService) =>
  service.list({ clinicId: "c-1", limit: 50, offset: 0 });

describe("appleUpdatesRegistered on the member summary", () => {
  it("is false when the synced Apple card has no registered device", async () => {
    const { service } = serviceFor([memberRow("m-1", [apple("serial-1")])], []);

    const [member] = await list(service);

    expect(member.appleUpdatesRegistered).toBe(false);
  });

  it("is true when the synced Apple card has a registered device", async () => {
    const { service } = serviceFor(
      [memberRow("m-1", [apple("serial-1")])],
      [{ passTypeIdentifier: PASS_TYPE, serialNumber: "serial-1" }]
    );

    const [member] = await list(service);

    expect(member.appleUpdatesRegistered).toBe(true);
  });

  it("is true however many devices hold the card", async () => {
    const { service } = serviceFor(
      [memberRow("m-1", [apple("serial-1")])],
      [
        { passTypeIdentifier: PASS_TYPE, serialNumber: "serial-1" },
        { passTypeIdentifier: PASS_TYPE, serialNumber: "serial-1" }
      ]
    );

    const [member] = await list(service);

    expect(member.appleUpdatesRegistered).toBe(true);
  });

  it("is null when the member has no Apple card", async () => {
    const { service, registrationsFindMany } = serviceFor(
      [memberRow("m-1", []), memberRow("m-2", [google("g-1")])],
      []
    );

    const members = await list(service);

    expect(members.map((m) => m.appleUpdatesRegistered)).toEqual([null, null]);
    // Nothing to look up, so nothing is asked of the database.
    expect(registrationsFindMany).not.toHaveBeenCalled();
  });

  it("is null while the Apple card is not SYNCED", async () => {
    const { service } = serviceFor(
      [
        memberRow("m-1", [apple("serial-1", WalletSyncStatus.PENDING)]),
        memberRow("m-2", [apple("serial-2", WalletSyncStatus.FAILED)])
      ],
      [{ passTypeIdentifier: PASS_TYPE, serialNumber: "serial-1" }]
    );

    const members = await list(service);

    expect(members.map((m) => m.appleUpdatesRegistered)).toEqual([null, null]);
  });

  it("is null when Apple is not configured, even if a registration exists", async () => {
    const { service, registrationsFindMany } = serviceFor(
      [memberRow("m-1", [apple("serial-1")])],
      [{ passTypeIdentifier: PASS_TYPE, serialNumber: "serial-1" }],
      { configured: [WalletProviderType.GOOGLE] }
    );

    const [member] = await list(service);

    expect(member.appleUpdatesRegistered).toBeNull();
    expect(member.walletStatus.apple).toBe("unavailable");
    expect(registrationsFindMany).not.toHaveBeenCalled();
  });

  it("is null when the pass type cannot be read from the certificate", async () => {
    const { service, registrationsFindMany } = serviceFor(
      [memberRow("m-1", [apple("serial-1")])],
      [{ passTypeIdentifier: PASS_TYPE, serialNumber: "serial-1" }],
      { passType: null }
    );

    const [member] = await list(service);

    expect(member.appleUpdatesRegistered).toBeNull();
    expect(registrationsFindMany).not.toHaveBeenCalled();
  });

  it("does one registrations query for the whole list, whatever its length", async () => {
    const members = Array.from({ length: 25 }, (_, i) =>
      memberRow(`m-${i}`, [apple(`serial-${i}`)])
    );
    const { service, registrationsFindMany } = serviceFor(members, [
      { passTypeIdentifier: PASS_TYPE, serialNumber: "serial-3" }
    ]);

    const summaries = await list(service);

    expect(registrationsFindMany).toHaveBeenCalledTimes(1);
    expect(summaries.filter((m) => m.appleUpdatesRegistered === true).map((m) => m.id)).toEqual([
      "m-3"
    ]);
    expect(summaries.filter((m) => m.appleUpdatesRegistered === false)).toHaveLength(24);
  });

  it("does not count a registration that belongs to another card", async () => {
    const { service } = serviceFor(
      [memberRow("m-1", [apple("serial-1")]), memberRow("m-2", [apple("serial-2")])],
      [{ passTypeIdentifier: PASS_TYPE, serialNumber: "serial-2" }]
    );

    const members = await list(service);

    expect(members.map((m) => [m.id, m.appleUpdatesRegistered])).toEqual([
      ["m-1", false],
      ["m-2", true]
    ]);
  });

  it("does not count a registration under a different pass type", async () => {
    const { service } = serviceFor(
      [memberRow("m-1", [apple("serial-1")])],
      [{ passTypeIdentifier: "pass.some.other", serialNumber: "serial-1" }]
    );

    const [member] = await list(service);

    expect(member.appleUpdatesRegistered).toBe(false);
  });

  it("is carried by the single-member detail as well", async () => {
    const registered = serviceFor(
      [memberRow("m-1", [apple("serial-1")])],
      [{ passTypeIdentifier: PASS_TYPE, serialNumber: "serial-1" }]
    );
    const unregistered = serviceFor([memberRow("m-1", [apple("serial-1")])], []);
    const none = serviceFor([memberRow("m-1", [])], []);

    expect((await registered.service.get("m-1")).appleUpdatesRegistered).toBe(true);
    expect((await unregistered.service.get("m-1")).appleUpdatesRegistered).toBe(false);
    expect((await none.service.get("m-1")).appleUpdatesRegistered).toBeNull();
    expect(registered.registrationsFindMany).toHaveBeenCalledTimes(1);
  });

  it("leaves every existing field as it was", async () => {
    const { service } = serviceFor([memberRow("m-1", [apple("serial-1")])], []);

    const [member] = await list(service);

    expect(member.walletStatus).toEqual({ apple: "added", google: "not_added" });
  });
});
