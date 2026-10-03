import dotenv from "dotenv";
import { WalletProviderType, WalletSyncStatus, type PrismaClient } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../src/infrastructure/database/prisma-client";
import { NotificationService } from "../src/modules/notifications/notification.service";
import { NotificationQuotaService } from "../src/modules/notifications/quota.service";
import { WalletPassEngine } from "../src/wallet/engine/wallet-pass.engine";
import { buildWalletRegistry } from "../src/wallet/wallet.composition";
import { GoogleWalletApiError } from "../src/wallet/providers/google/client";
import { getLoyaltyClassLocations } from "../src/wallet/providers/google";

dotenv.config();

const inputSchema = z.object({
  clinicId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  dryRun: z.boolean().default(false)
});

interface CliInput {
  clinicId?: string;
  name?: string;
  lat?: string;
  lng?: string;
  dryRun: boolean;
}

const parseArgs = (argv: string[]): CliInput => {
  const parsed: CliInput = { dryRun: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const key = arg.slice(2) as keyof Omit<CliInput, "dryRun">;
    const value = argv[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }

    if (!(["clinicId", "name", "lat", "lng"] as string[]).includes(key)) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    parsed[key] = value;
    index += 1;
  }

  return parsed;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const input = inputSchema.parse({
    clinicId: args.clinicId ?? process.env.TEST_CLINIC_ID,
    name: args.name ?? process.env.TEST_GEO_NAME,
    lat: args.lat ?? process.env.TEST_GEO_LAT,
    lng: args.lng ?? process.env.TEST_GEO_LNG,
    dryRun: args.dryRun
  });

  const walletClass = await resolveWalletClass(prisma, input.clinicId);

  console.log("Selected test Google Wallet class", {
    clinicId: walletClass.clinicId,
    clinicName: walletClass.clinicName,
    externalClassId: walletClass.externalClassId
  });

  const existingLocations = await prisma.clinicLocation.findMany({
    where: { clinicId: walletClass.clinicId },
    orderBy: { createdAt: "asc" }
  });
  const nextLocation = { name: input.name, latitude: input.lat, longitude: input.lng };
  const existingIndex = existingLocations.findIndex((location) => location.name === input.name);

  if (existingIndex < 0 && existingLocations.length >= 10) {
    throw new Error(
      `Clinic already has ${existingLocations.length} saved locations; Google allows at most 10.`
    );
  }

  const nextLocations = existingLocations.map((location) => ({
    name: location.name,
    latitude: location.latitude,
    longitude: location.longitude
  }));

  if (existingIndex >= 0) {
    nextLocations[existingIndex] = nextLocation;
  } else {
    nextLocations.push(nextLocation);
  }

  if (input.dryRun) {
    console.log("Dry run: no database rows or Google Wallet class will be changed.");
    console.log("Would send merchantLocations", nextLocations);
    return;
  }

  console.log("Patching Google Wallet LoyaltyClass with merchantLocations", {
    classId: walletClass.externalClassId,
    count: nextLocations.length,
    location: nextLocation
  });

  const service = new NotificationService(
    prisma,
    new WalletPassEngine(buildWalletRegistry(prisma)),
    new NotificationQuotaService({} as never),
    {} as never
  );

  await service.setLocations(walletClass.clinicId, nextLocations, { role: "VOONE_ADMIN" });

  const persistedClass = await getLoyaltyClassLocations(walletClass.externalClassId);
  const merchantLocations = persistedClass.merchantLocations ?? [];
  const persistedLocation = merchantLocations.find(
    (location) =>
      nearlyEqual(location.latitude, input.lat) && nearlyEqual(location.longitude, input.lng)
  );

  console.log("Google Wallet LoyaltyClass read-back", {
    classId: persistedClass.id,
    merchantLocations: merchantLocations.map((location) => ({
      lat: location.latitude,
      lng: location.longitude
    })),
    count: merchantLocations.length
  });

  if (!persistedLocation) {
    throw new Error(
      `Read-back did not contain lat=${input.lat}, lng=${input.lng} on ${walletClass.externalClassId}`
    );
  }

  console.log("Merchant location verified on Google Wallet", {
    classId: persistedClass.id,
    lat: persistedLocation.latitude,
    lng: persistedLocation.longitude
  });
};

const resolveWalletClass = async (client: PrismaClient, clinicId?: string) => {
  const classes = await client.walletClass.findMany({
    where: {
      provider: WalletProviderType.GOOGLE,
      status: WalletSyncStatus.SYNCED,
      ...(clinicId ? { clinicTemplate: { clinicId } } : {})
    },
    select: {
      externalClassId: true,
      clinicTemplate: { select: { clinicId: true, clinic: { select: { name: true } } } }
    },
    orderBy: { createdAt: "asc" }
  });

  if (classes.length === 0) {
    throw new Error(
      clinicId
        ? `No synced Google WalletClass found for clinic ${clinicId}`
        : "No synced Google WalletClass rows found."
    );
  }

  if (!clinicId && classes.length > 1) {
    console.error(
      "More than one synced Google WalletClass exists. Set TEST_CLINIC_ID or pass --clinicId."
    );
    console.table(
      classes.map((walletClass) => ({
        clinicId: walletClass.clinicTemplate.clinicId,
        clinicName: walletClass.clinicTemplate.clinic.name,
        externalClassId: walletClass.externalClassId
      }))
    );
    process.exit(1);
  }

  const selected = classes[0];

  return {
    clinicId: selected.clinicTemplate.clinicId,
    clinicName: selected.clinicTemplate.clinic.name,
    externalClassId: selected.externalClassId
  };
};

const nearlyEqual = (left: number, right: number): boolean => Math.abs(left - right) < 0.000001;

void main()
  .catch((error) => {
    if (error instanceof GoogleWalletApiError) {
      console.error("Google Wallet API call failed", {
        status: error.status,
        statusText: error.statusText,
        responseBody: error.responseBody
      });
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
