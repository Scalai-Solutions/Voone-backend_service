-- Evidence that an Apple pass reached a person. WalletObject is written when the pass is
-- issued, so it cannot tell "never installed" from "installed, no longer registered".
-- Both columns are nullable: existing credentials have no evidence until their member
-- next downloads the pass or a phone registers.

-- AlterTable
ALTER TABLE "ApplePassCredential" ADD COLUMN     "downloadedAt" TIMESTAMP(3),
ADD COLUMN     "firstRegisteredAt" TIMESTAMP(3);
