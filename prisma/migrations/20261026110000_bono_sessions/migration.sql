-- Bono de sesiones: a session-pack treatment the centre sells and a member consumes over
-- several visits. BonoPlan is what the centre defines during onboarding (price per session,
-- total sessions); MemberBono is what a member holds, with the plan SNAPSHOTTED so later
-- edits cannot rewrite a bono someone is part-way through, plus how many sessions are used.
--
-- PaidVisit gains the link and the 1-based session number: the unique index on
-- (memberBonoId, bonoSessionNumber) is what makes a double tap at reception unable to burn
-- two sessions. bonusProgress is the optional whole-euros gift recorded with a visit,
-- kept separate from amountCents so an audit can tell purchase from gift.
--
-- MemberBono holds the treatment name, so it is erasable data in its own table (the
-- financial record keeps amounts only); member erasure deletes these rows in the
-- directory service. BONO_REMINDER is the monthly automation's notification type, and the
-- ClinicNotificationSettings columns are its per-clinic toggle and copy.

-- CreateEnum
CREATE TYPE "MemberBonoStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'BONO_REMINDER';

-- AlterTable
ALTER TABLE "ClinicNotificationSettings" ADD COLUMN     "bonoReminderBody" TEXT NOT NULL DEFAULT 'Te quedan sesiones de tu bono. Reserva tu próxima cita cuando quieras.',
ADD COLUMN     "bonoReminderEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "bonoReminderHeader" TEXT NOT NULL DEFAULT 'Tienes sesiones pendientes',
ADD COLUMN     "bonoReminderLastRunMonth" TEXT,
ADD COLUMN     "bonoReminderNotify" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "PaidVisit" ADD COLUMN     "bonoSessionNumber" INTEGER,
ADD COLUMN     "bonusProgress" INTEGER,
ADD COLUMN     "memberBonoId" TEXT;

-- CreateTable
CREATE TABLE "BonoPlan" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pricePerSessionCents" INTEGER NOT NULL,
    "totalSessions" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BonoPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberBono" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "planId" TEXT,
    "name" TEXT NOT NULL,
    "pricePerSessionCents" INTEGER NOT NULL,
    "totalSessions" INTEGER NOT NULL,
    "sessionsUsed" INTEGER NOT NULL DEFAULT 0,
    "status" "MemberBonoStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberBono_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BonoPlan_clinicId_idx" ON "BonoPlan"("clinicId");

-- CreateIndex
CREATE INDEX "MemberBono_clinicId_status_idx" ON "MemberBono"("clinicId", "status");

-- CreateIndex
CREATE INDEX "MemberBono_memberId_status_idx" ON "MemberBono"("memberId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaidVisit_memberBonoId_bonoSessionNumber_key" ON "PaidVisit"("memberBonoId", "bonoSessionNumber");

-- AddForeignKey
ALTER TABLE "PaidVisit" ADD CONSTRAINT "PaidVisit_memberBonoId_fkey" FOREIGN KEY ("memberBonoId") REFERENCES "MemberBono"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BonoPlan" ADD CONSTRAINT "BonoPlan_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberBono" ADD CONSTRAINT "MemberBono_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberBono" ADD CONSTRAINT "MemberBono_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberBono" ADD CONSTRAINT "MemberBono_planId_fkey" FOREIGN KEY ("planId") REFERENCES "BonoPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
