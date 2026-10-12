-- The onboarding engine's input and its output.
--
-- CatalogItem is deliberately NOT an extension of ClinicTreatment. The engine's
-- determinism rests on stable item ids — they are the final tie-break in every sort —
-- and treatmentsRepository.replaceForClinic deletes every treatment row and recreates it
-- on each template save, minting fresh uuids. A catalogue kept there would silently
-- regenerate a different reward ladder after an unrelated edit to the card's copy.
--
-- The two tables therefore coexist for now. That duplication is meant to be temporary:
-- ClinicTreatment's `pointsAllotted` is superseded by the engine's progress-in-euros
-- model, and it should be retired when the onboarding wizard is rewritten.
--
-- Prices are cents. The engine does float arithmetic on euros, and a decimal column read
-- back as a float is how a ladder ends up differing by a cent and therefore by a
-- tie-break.

CREATE TYPE "OnboardingProgramStatus" AS ENUM ('BORRADOR', 'ACTIVO', 'SUSTITUIDO');

CREATE TABLE "CatalogItem" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "durationMin" INTEGER,
    "isProduct" BOOLEAN NOT NULL DEFAULT false,
    "categoryId" TEXT,
    "costPctOverride" DOUBLE PRECISION,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "classificationSource" TEXT,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogItem_pkey" PRIMARY KEY ("id")
);

-- A price cannot be negative, and a cost ratio is a share of one. Enforced here rather
-- than only in Zod, because the engine divides by these and a bad row would surface as a
-- nonsensical ladder rather than as a validation error.
ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_priceCents_nonneg" CHECK ("priceCents" >= 0);
ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_costPct_range"
    CHECK ("costPctOverride" IS NULL OR ("costPctOverride" >= 0 AND "costPctOverride" <= 1));

CREATE UNIQUE INDEX "CatalogItem_clinicId_externalId_key" ON "CatalogItem"("clinicId", "externalId");
CREATE INDEX "CatalogItem_clinicId_position_idx" ON "CatalogItem"("clinicId", "position");

ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OnboardingProgram" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "OnboardingProgramStatus" NOT NULL DEFAULT 'BORRADOR',
    "engineVersion" TEXT NOT NULL,
    "configVersion" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "catalogSnapshot" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingProgram_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OnboardingProgram_clinicId_version_key" ON "OnboardingProgram"("clinicId", "version");
CREATE INDEX "OnboardingProgram_clinicId_status_idx" ON "OnboardingProgram"("clinicId", "status");

ALTER TABLE "OnboardingProgram" ADD CONSTRAINT "OnboardingProgram_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
