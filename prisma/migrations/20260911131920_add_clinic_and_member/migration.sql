-- CreateEnum
CREATE TYPE "MemberTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND');

-- CreateTable
CREATE TABLE "Clinic" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "privacyPolicyVersion" TEXT NOT NULL DEFAULT 'v1',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Clinic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phoneRaw" TEXT,
    "normalizerVersion" INTEGER NOT NULL DEFAULT 1,
    "phoneRegionAssumed" BOOLEAN NOT NULL DEFAULT false,
    "memberSince" INTEGER NOT NULL,
    "tier" "MemberTier" NOT NULL DEFAULT 'BRONZE',
    "locale" TEXT NOT NULL DEFAULT 'es-ES',
    "consentMarketing" BOOLEAN NOT NULL,
    "consentMarketingAt" TIMESTAMP(3),
    "privacyPolicyVersion" TEXT NOT NULL,
    "consentSource" TEXT NOT NULL DEFAULT 'qr_signup',
    "signupCount" INTEGER NOT NULL DEFAULT 1,
    "lastSignupAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erasedAt" TIMESTAMP(3),

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Clinic_slug_key" ON "Clinic"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Member_clinicId_phone_key" ON "Member"("clinicId", "phone");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-added. Member_clinicId_phone_key only detects duplicates if every writer stores
-- the same canonical form, so the format is enforced here rather than trusted from the
-- service. The tombstone branch is for erasure, which overwrites phone with a random
-- value so the unique index stays satisfiable and the person can register again.
ALTER TABLE "Member"
  ADD CONSTRAINT "Member_phone_e164_es"
  CHECK ("phone" ~ '^\+34[67][0-9]{8}$' OR "phone" LIKE 'erased:%');
