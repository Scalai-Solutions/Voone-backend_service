-- Key Apple pass state by (passTypeIdentifier, serialNumber), which is how Apple itself
-- identifies a pass.
--
-- Our serial numbers are derived from the member, so they repeat across pass types. Keyed
-- on the serial alone, issuing a pass under a new pass type overwrites the credential of
-- the one the member is still carrying, and that pass starts failing every web service
-- call at once — no update, no warning, and no way back except re-adding.
--
-- That is not hypothetical: the plan is to migrate from pass.ai.voone.giftcard on the
-- individual account to pass.ai.voone.loyalty on the company one. Both must work while
-- members move across.
--
-- Safe as written because both tables are empty: no pass has been issued. The NOT NULL
-- column is added without a default for exactly that reason — if either table has rows by
-- the time this runs, it fails loudly rather than inventing a pass type for them.

-- AlterTable
ALTER TABLE "ApplePassCredential" DROP CONSTRAINT "ApplePassCredential_pkey";
ALTER TABLE "ApplePassCredential" ADD COLUMN "passTypeIdentifier" TEXT NOT NULL;
ALTER TABLE "ApplePassCredential" ADD CONSTRAINT "ApplePassCredential_pkey" PRIMARY KEY ("passTypeIdentifier", "serialNumber");

-- AlterTable
DROP INDEX "PassDeviceRegistration_deviceLibraryIdentifier_serialNumber_key";
CREATE UNIQUE INDEX "PassDeviceRegistration_device_passType_serial_key" ON "PassDeviceRegistration"("deviceLibraryIdentifier", "passTypeIdentifier", "serialNumber");
