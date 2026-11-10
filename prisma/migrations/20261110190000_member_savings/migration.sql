-- What the programme has saved each member: gifts redeemed and tier discounts taken.

CREATE TYPE "MemberSavingKind" AS ENUM ('GIFT', 'PERK', 'DISCOUNT', 'ADJUSTMENT');

ALTER TABLE "Clinic" ADD COLUMN "perkValues" JSONB;
ALTER TABLE "Member" ADD COLUMN "savingsCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PaidVisit" ADD COLUMN "discountedListCents" INTEGER;

CREATE TABLE "MemberSaving" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "kind" "MemberSavingKind" NOT NULL,
    "cents" INTEGER NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "discountRate" DECIMAL(5,4),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "MemberSaving_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemberSaving_memberId_sourceKey_key" ON "MemberSaving"("memberId", "sourceKey");
CREATE INDEX "MemberSaving_memberId_createdAt_idx" ON "MemberSaving"("memberId", "createdAt");
CREATE INDEX "MemberSaving_clinicId_createdAt_idx" ON "MemberSaving"("clinicId", "createdAt");

ALTER TABLE "MemberSaving" ADD CONSTRAINT "MemberSaving_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberSaving" ADD CONSTRAINT "MemberSaving_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A saving is never zero, and only a hand correction may be negative.
ALTER TABLE "MemberSaving" ADD CONSTRAINT "MemberSaving_cents_sign_check"
  CHECK ("cents" <> 0 AND ("kind" = 'ADJUSTMENT' OR "cents" > 0));
