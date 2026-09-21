-- Apple's pass web service: the state a device needs to be told a pass changed.
--
-- Additive only; nothing existing is altered beyond one index.
--
-- ApplePassCredential is its own table rather than a column on WalletObject. The token is
-- meaningful only to a provider whose pass is a file on a device, so it does not belong on
-- a model both providers share — and it must be written before the pass is signed, since
-- the token goes inside the file, which is before the WalletObject row exists.
--
-- PassDeviceRegistration deliberately has no foreign key to Member or WalletObject. A
-- device knows a serial and nothing else, and an erased member's registrations must stay
-- findable so they can be cleared rather than orphaned behind a cascade.

-- CreateIndex
CREATE INDEX "WalletObject_externalObjectId_idx" ON "WalletObject"("externalObjectId");

-- CreateTable
CREATE TABLE "ApplePassCredential" (
    "serialNumber" TEXT NOT NULL,
    "authenticationToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplePassCredential_pkey" PRIMARY KEY ("serialNumber")
);

-- CreateTable
CREATE TABLE "PassDeviceRegistration" (
    "id" TEXT NOT NULL,
    "deviceLibraryIdentifier" TEXT NOT NULL,
    "passTypeIdentifier" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PassDeviceRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PassDeviceRegistration_deviceLibraryIdentifier_serialNumber_key" ON "PassDeviceRegistration"("deviceLibraryIdentifier", "serialNumber");

-- CreateIndex
CREATE INDEX "PassDeviceRegistration_deviceLibraryIdentifier_passTypeIdent_idx" ON "PassDeviceRegistration"("deviceLibraryIdentifier", "passTypeIdentifier");

-- CreateIndex
CREATE INDEX "PassDeviceRegistration_serialNumber_idx" ON "PassDeviceRegistration"("serialNumber");
