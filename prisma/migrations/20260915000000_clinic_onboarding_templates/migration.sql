-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'MANAGER', 'STAFF', 'VOONE_ADMIN');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED');

-- CreateEnum
CREATE TYPE "WalletProviderType" AS ENUM ('GOOGLE', 'APPLE');

-- CreateEnum
CREATE TYPE "WalletSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- CreateTable
CREATE TABLE "Clinic" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Clinic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicTreatment" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pointsAllotted" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicTreatment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplatePreset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hexBackgroundColor" TEXT NOT NULL,
    "previewImageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplatePreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicTemplate" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "programName" TEXT NOT NULL,
    "hexBackgroundColor" TEXT NOT NULL,
    "logoUrl" TEXT,
    "heroImageUrl" TEXT,
    "pointsLabel" TEXT NOT NULL,
    "tierLabel" TEXT NOT NULL,
    "benefitsText" TEXT NOT NULL,
    "infoText" TEXT NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "pointsBalance" INTEGER NOT NULL DEFAULT 0,
    "tier" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletClass" (
    "id" TEXT NOT NULL,
    "clinicTemplateId" TEXT NOT NULL,
    "provider" "WalletProviderType" NOT NULL,
    "externalClassId" TEXT NOT NULL,
    "status" "WalletSyncStatus" NOT NULL DEFAULT 'PENDING',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletObject" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "provider" "WalletProviderType" NOT NULL,
    "externalObjectId" TEXT NOT NULL,
    "status" "WalletSyncStatus" NOT NULL DEFAULT 'PENDING',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletObject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_clinicId_idx" ON "User"("clinicId");

-- CreateIndex
CREATE INDEX "ClinicTreatment_clinicId_idx" ON "ClinicTreatment"("clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "TemplatePreset_name_key" ON "TemplatePreset"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicTemplate_clinicId_key" ON "ClinicTemplate"("clinicId");

-- CreateIndex
CREATE INDEX "ClinicTemplate_presetId_idx" ON "ClinicTemplate"("presetId");

-- CreateIndex
CREATE INDEX "Member_clinicId_idx" ON "Member"("clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletClass_clinicTemplateId_provider_key" ON "WalletClass"("clinicTemplateId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "WalletObject_memberId_provider_key" ON "WalletObject"("memberId", "provider");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicTreatment" ADD CONSTRAINT "ClinicTreatment_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicTemplate" ADD CONSTRAINT "ClinicTemplate_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicTemplate" ADD CONSTRAINT "ClinicTemplate_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "TemplatePreset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletClass" ADD CONSTRAINT "WalletClass_clinicTemplateId_fkey" FOREIGN KEY ("clinicTemplateId") REFERENCES "ClinicTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletObject" ADD CONSTRAINT "WalletObject_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;