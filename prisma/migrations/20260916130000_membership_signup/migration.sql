-- Folds the public sign-up feature onto the clinic-onboarding schema.
--
-- Dated after 20260915000000_clinic_onboarding_templates on purpose: that migration is
-- already applied to Supabase, and an earlier timestamp would read as drift rather than
-- a new step.
--
-- Clinic.slug is added NOT NULL with no default, and the constraints below are added
-- VALID rather than NOT VALID, because Clinic and Member were both verified empty before
-- this was written and no code path creates a Member yet. If either assumption has since
-- broken, this migration fails loudly — which is the outcome to want, since silently
-- grandfathering unnormalized phone numbers would make the unique index below a lie.

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "privacyPolicyVersion" TEXT NOT NULL DEFAULT 'v1',
ADD COLUMN     "slug" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "consentMarketing" BOOLEAN NOT NULL,
ADD COLUMN     "consentMarketingAt" TIMESTAMP(3),
ADD COLUMN     "consentSource" TEXT NOT NULL,
ADD COLUMN     "erasedAt" TIMESTAMP(3),
ADD COLUMN     "lastSignupAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'es-ES',
ADD COLUMN     "memberSince" INTEGER,
ADD COLUMN     "normalizerVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "phoneRaw" TEXT,
ADD COLUMN     "phoneRegionAssumed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "privacyPolicyVersion" TEXT,
ADD COLUMN     "signupCount" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "Clinic_slug_key" ON "Clinic"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Member_clinicId_phone_key" ON "Member"("clinicId", "phone");


-- Hand-added: Member_clinicId_phone_key only detects duplicates if every writer stores the
-- same canonical form, so the format is enforced here rather than trusted from the service.
--
-- NULL is permitted so the dashboard's add-by-email path keeps working; Postgres treats
-- NULLs as distinct in a unique index, so many email-only members coexist while a real
-- number still cannot repeat. The tombstone branch is for erasure, which overwrites phone
-- with a random value so the unique index stays satisfiable and the person can register again.
ALTER TABLE "Member"
  ADD CONSTRAINT "Member_phone_e164_es"
  CHECK ("phone" IS NULL OR "phone" ~ '^\+34[67][0-9]{8}$' OR "phone" LIKE 'erased:%');
