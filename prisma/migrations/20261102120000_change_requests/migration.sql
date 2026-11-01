-- CreateEnum
CREATE TYPE "ChangeRequestType" AS ENUM ('REWARD', 'LEVEL', 'SERVICE_EDIT', 'SERVICE_ADD', 'SERVICE_REMOVE', 'BONO', 'OTHER');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ChangeRequestAuthorKind" AS ENUM ('CLINIC', 'VOONE');

-- CreateTable
CREATE TABLE "ChangeRequest" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "type" "ChangeRequestType" NOT NULL,
    "targetRef" JSONB,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "proposed" JSONB,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'OPEN',
    "createdByEmail" TEXT NOT NULL,
    "createdByRole" TEXT NOT NULL,
    "resolvedByEmail" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedByEmail" TEXT,
    "programId" TEXT,
    "emailSentAt" TIMESTAMP(3),
    "lastEmailError" TEXT,
    "lastEmailErrorKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeRequestMessage" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "authorKind" "ChangeRequestAuthorKind" NOT NULL,
    "authorEmail" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeRequestMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChangeRequest_clinicId_status_createdAt_idx" ON "ChangeRequest"("clinicId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ChangeRequest_clinicId_createdAt_idx" ON "ChangeRequest"("clinicId", "createdAt");

-- CreateIndex
CREATE INDEX "ChangeRequest_status_createdAt_idx" ON "ChangeRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ChangeRequest_createdAt_idx" ON "ChangeRequest"("createdAt");

-- CreateIndex
CREATE INDEX "ChangeRequest_programId_idx" ON "ChangeRequest"("programId");

-- CreateIndex
CREATE INDEX "ChangeRequestMessage_requestId_createdAt_idx" ON "ChangeRequestMessage"("requestId", "createdAt");

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_programId_fkey" FOREIGN KEY ("programId") REFERENCES "OnboardingProgram"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequestMessage" ADD CONSTRAINT "ChangeRequestMessage_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ChangeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
