-- Automated notifications move from flat per-event columns on ClinicNotificationSettings to one
-- ClinicAutomation row per (clinic, event), and gain per-member rendered text on deliveries.
-- Adding an event is now a catalog entry in code, not a migration.

-- The new NotificationType values are not used in this migration, so ADD VALUE is safe here.
ALTER TYPE "NotificationType" ADD VALUE 'REVIEW_REQUEST';
ALTER TYPE "NotificationType" ADD VALUE 'REFERRAL_PROMO';

CREATE TYPE "AutomationEvent" AS ENUM ('BIRTHDAY', 'BONO_INACTIVE', 'REVIEW_REQUEST', 'REFERRAL_PROMO', 'TIER_UPGRADE');

CREATE TABLE "ClinicAutomation" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "event" "AutomationEvent" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "header" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "notify" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicAutomation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClinicAutomation_clinicId_event_key" ON "ClinicAutomation"("clinicId", "event");

ALTER TABLE "ClinicAutomation" ADD CONSTRAINT "ClinicAutomation_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry every clinic's existing birthday copy across unchanged.
INSERT INTO "ClinicAutomation" ("id", "clinicId", "event", "enabled", "header", "body", "notify", "updatedAt")
SELECT gen_random_uuid()::text, "clinicId", 'BIRTHDAY', "birthdayEnabled", "birthdayHeader", "birthdayBody", "birthdayNotify", CURRENT_TIMESTAMP
FROM "ClinicNotificationSettings"
ON CONFLICT ("clinicId", "event") DO NOTHING;

-- The bono reminder becomes EVT-003 (inactive bono). Copy still equal to the old default moves
-- to the new Spanish text; anything a clinic customised is kept as written.
INSERT INTO "ClinicAutomation" ("id", "clinicId", "event", "enabled", "header", "body", "notify", "updatedAt")
SELECT
    gen_random_uuid()::text,
    "clinicId",
    'BONO_INACTIVE',
    "bonoReminderEnabled",
    CASE WHEN "bonoReminderHeader" = 'Tienes sesiones pendientes'
         THEN '¡No olvides tu tratamiento! 💆‍♀️' ELSE "bonoReminderHeader" END,
    CASE WHEN "bonoReminderBody" = 'Te quedan sesiones de tu bono. Reserva tu próxima cita cuando quieras.'
         THEN 'Hola {first_name}, hace un mes que no usas las sesiones de tu bono en {clinic_name}. Recuerda que la constancia es la clave para obtener los mejores resultados. ¡Reserva tu próxima sesión hoy!'
         ELSE "bonoReminderBody" END,
    "bonoReminderNotify",
    CURRENT_TIMESTAMP
FROM "ClinicNotificationSettings"
ON CONFLICT ("clinicId", "event") DO NOTHING;

-- Additive only: the old birthday*/bonoReminder* columns stay (unused) so an older instance or a
-- rollback keeps working; a later migration drops them.
ALTER TABLE "ClinicNotificationSettings"
    ADD COLUMN "googleReviewUrl" TEXT,
    ADD COLUMN "referralRewardText" TEXT;

ALTER TABLE "NotificationDelivery" ADD COLUMN "header" TEXT, ADD COLUMN "body" TEXT;

-- Close the duplicate-delivery gap that code used to guard with in-memory sets. Keep the oldest
-- row of any existing duplicate so the index can be built.
DELETE FROM "NotificationDelivery" d
USING "NotificationDelivery" k
WHERE d."notificationId" = k."notificationId"
  AND d."memberId" = k."memberId"
  AND d."provider" = k."provider"
  AND d."id" > k."id";

CREATE UNIQUE INDEX "NotificationDelivery_notificationId_memberId_provider_key"
    ON "NotificationDelivery"("notificationId", "memberId", "provider");
