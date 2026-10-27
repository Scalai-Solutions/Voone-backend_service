import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { PrismaPassDeviceRepository } from "../../src/wallet/prisma-pass-device.repository";

const db = new PrismaClient();
const repo = new PrismaPassDeviceRepository(db);

const PASS_TYPE = "pass.test.registered-serials";
const OTHER_PASS_TYPE = "pass.test.registered-serials.other";
const SERIALS = ["rs-serial-a", "rs-serial-b", "rs-serial-c"];

const register = (device: string, passTypeIdentifier: string, serialNumber: string) =>
  repo.saveRegistration({
    deviceLibraryIdentifier: device,
    passTypeIdentifier,
    serialNumber,
    pushToken: `token-${device}`
  });

afterEach(async () => {
  await db.passDeviceRegistration.deleteMany({
    where: { passTypeIdentifier: { in: [PASS_TYPE, OTHER_PASS_TYPE] } }
  });
});

afterAll(async () => {
  await db.$disconnect();
});

describe("PrismaPassDeviceRepository.registeredSerials", () => {
  it("returns only the serials that have at least one registration", async () => {
    await register("device-1", PASS_TYPE, "rs-serial-a");
    await register("device-2", PASS_TYPE, "rs-serial-a");

    const registered = await repo.registeredSerials(PASS_TYPE, SERIALS);

    expect([...registered]).toEqual(["rs-serial-a"]);
  });

  it("ignores serials that were not asked about", async () => {
    await register("device-1", PASS_TYPE, "rs-serial-a");
    await register("device-1", PASS_TYPE, "rs-serial-b");

    const registered = await repo.registeredSerials(PASS_TYPE, ["rs-serial-b"]);

    expect([...registered]).toEqual(["rs-serial-b"]);
  });

  it("is scoped by pass type", async () => {
    await register("device-1", OTHER_PASS_TYPE, "rs-serial-a");

    const registered = await repo.registeredSerials(PASS_TYPE, SERIALS);

    expect(registered.size).toBe(0);
  });

  it("answers an empty list without a query", async () => {
    const registered = await repo.registeredSerials(PASS_TYPE, []);

    expect(registered.size).toBe(0);
  });
});
