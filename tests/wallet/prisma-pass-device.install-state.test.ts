import { PrismaClient, WalletProviderType, WalletSyncStatus } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaPassDeviceRepository } from "../../src/wallet/prisma-pass-device.repository";

const db = new PrismaClient();
const repo = new PrismaPassDeviceRepository(db);

const PASS_TYPE = "pass.test.install-state";
const OTHER_PASS_TYPE = "pass.test.install-state.other";
const SLUG = "test-install-state";

let clinicId: string;

const credential = (serialNumber: string, passTypeIdentifier = PASS_TYPE) =>
  db.applePassCredential.upsert({
    where: { passTypeIdentifier_serialNumber: { passTypeIdentifier, serialNumber } },
    update: {},
    create: { passTypeIdentifier, serialNumber, authenticationToken: `token-${serialNumber}` }
  });

const register = (device: string, serialNumber: string, passTypeIdentifier = PASS_TYPE) =>
  repo.saveRegistration({
    deviceLibraryIdentifier: device,
    passTypeIdentifier,
    serialNumber,
    pushToken: `push-${device}`
  });

const credentialOf = (serialNumber: string) =>
  db.applePassCredential.findUniqueOrThrow({
    where: { passTypeIdentifier_serialNumber: { passTypeIdentifier: PASS_TYPE, serialNumber } }
  });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  const clinic = await db.clinic.upsert({
    where: { slug: SLUG },
    update: {},
    create: { slug: SLUG, name: "Install state", addressLine: "Calle 1", pincode: "28001" }
  });

  clinicId = clinic.id;
});

afterEach(async () => {
  await db.passDeviceRegistration.deleteMany({
    where: { passTypeIdentifier: { in: [PASS_TYPE, OTHER_PASS_TYPE] } }
  });
  await db.applePassCredential.deleteMany({
    where: { passTypeIdentifier: { in: [PASS_TYPE, OTHER_PASS_TYPE] } }
  });
  await db.walletObject.deleteMany({ where: { member: { clinicId } } });
  await db.member.deleteMany({ where: { clinicId } });
});

afterAll(async () => {
  await db.clinic.deleteMany({ where: { id: clinicId } });
  await db.$disconnect();
});

describe("PrismaPassDeviceRepository.installState", () => {
  it("lists the serials that have at least one registration", async () => {
    await credential("is-a");
    await credential("is-b");
    await register("device-1", "is-a");
    await register("device-2", "is-a");

    const state = await repo.installState(PASS_TYPE, ["is-a", "is-b", "is-c"]);

    expect([...state.registered]).toEqual(["is-a"]);
  });

  it("lists as evidenced the serials that were downloaded or ever registered", async () => {
    await credential("is-downloaded");
    await credential("is-registered-once");
    await credential("is-neither");
    await db.applePassCredential.updateMany({
      where: { passTypeIdentifier: PASS_TYPE, serialNumber: "is-downloaded" },
      data: { downloadedAt: new Date() }
    });
    await db.applePassCredential.updateMany({
      where: { passTypeIdentifier: PASS_TYPE, serialNumber: "is-registered-once" },
      data: { firstRegisteredAt: new Date() }
    });

    const state = await repo.installState(PASS_TYPE, [
      "is-downloaded",
      "is-registered-once",
      "is-neither",
      "is-no-credential"
    ]);

    expect([...state.evidenced].sort()).toEqual(["is-downloaded", "is-registered-once"]);
    expect(state.registered.size).toBe(0);
  });

  it("is scoped by pass type", async () => {
    await credential("is-a", OTHER_PASS_TYPE);
    await register("device-1", "is-a", OTHER_PASS_TYPE);
    await db.applePassCredential.updateMany({
      where: { passTypeIdentifier: OTHER_PASS_TYPE },
      data: { downloadedAt: new Date() }
    });

    const state = await repo.installState(PASS_TYPE, ["is-a"]);

    expect(state.registered.size).toBe(0);
    expect(state.evidenced.size).toBe(0);
  });

  it("asks the database at most twice for a whole list", async () => {
    const registrations = vi.spyOn(db.passDeviceRegistration, "findMany");
    const credentials = vi.spyOn(db.applePassCredential, "findMany");

    await repo.installState(
      PASS_TYPE,
      Array.from({ length: 25 }, (_, i) => `is-${i}`)
    );

    expect(registrations).toHaveBeenCalledTimes(1);
    expect(credentials).toHaveBeenCalledTimes(1);
  });

  it("answers an empty list without asking the database anything", async () => {
    const registrations = vi.spyOn(db.passDeviceRegistration, "findMany");
    const credentials = vi.spyOn(db.applePassCredential, "findMany");

    const state = await repo.installState(PASS_TYPE, []);

    expect(state.registered.size).toBe(0);
    expect(state.evidenced.size).toBe(0);
    expect(registrations).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
  });
});

describe("firstRegisteredAt", () => {
  it("is set by the first registration and left alone by later ones", async () => {
    await credential("fr-a");
    expect((await credentialOf("fr-a")).firstRegisteredAt).toBeNull();

    await register("device-1", "fr-a");
    const first = (await credentialOf("fr-a")).firstRegisteredAt;

    expect(first).toBeInstanceOf(Date);

    await pause(15);
    await register("device-2", "fr-a");
    await register("device-1", "fr-a");

    expect((await credentialOf("fr-a")).firstRegisteredAt).toEqual(first);
  });

  it("survives the registration being removed, which is the evidence it exists for", async () => {
    await credential("fr-b");
    await register("device-1", "fr-b");
    const first = (await credentialOf("fr-b")).firstRegisteredAt;

    await repo.removeRegistration("device-1", PASS_TYPE, "fr-b");

    const state = await repo.installState(PASS_TYPE, ["fr-b"]);

    expect(state.registered.size).toBe(0);
    expect([...state.evidenced]).toEqual(["fr-b"]);
    expect((await credentialOf("fr-b")).firstRegisteredAt).toEqual(first);
  });

  it("does not fail a registration whose credential row is missing", async () => {
    await expect(register("device-1", "fr-no-credential")).resolves.toEqual({ created: true });
  });
});

describe("markDownloadedForMember", () => {
  const memberWithApplePass = async (serial: string) => {
    const member = await db.member.create({
      data: { clinicId, name: "Descarga", consentMarketing: false, consentSource: "test" }
    });

    await db.walletObject.create({
      data: {
        memberId: member.id,
        provider: WalletProviderType.APPLE,
        externalObjectId: serial,
        status: WalletSyncStatus.SYNCED
      }
    });
    await credential(serial);

    return member.id;
  };

  it("stamps the member's Apple credential, and moves the stamp on every later download", async () => {
    const memberId = await memberWithApplePass("dl-a");

    expect((await credentialOf("dl-a")).downloadedAt).toBeNull();

    await repo.markDownloadedForMember(PASS_TYPE, memberId);
    const first = (await credentialOf("dl-a")).downloadedAt;

    expect(first).toBeInstanceOf(Date);

    await pause(15);
    await repo.markDownloadedForMember(PASS_TYPE, memberId);

    const second = (await credentialOf("dl-a")).downloadedAt as Date;

    expect(second.getTime()).toBeGreaterThan((first as Date).getTime());
  });

  it("touches only the pass type asked about", async () => {
    const memberId = await memberWithApplePass("dl-b");

    await repo.markDownloadedForMember(OTHER_PASS_TYPE, memberId);

    expect((await credentialOf("dl-b")).downloadedAt).toBeNull();
  });

  it("does nothing for a member with no Apple card or no credential", async () => {
    const member = await db.member.create({
      data: { clinicId, name: "Sin pase", consentMarketing: false, consentSource: "test" }
    });

    await expect(repo.markDownloadedForMember(PASS_TYPE, member.id)).resolves.toBeUndefined();
  });
});
