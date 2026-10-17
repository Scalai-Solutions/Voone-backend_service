ALTER TYPE "NotificationType" ADD VALUE 'BIRTHDAY';

ALTER TABLE "ClinicNotificationSettings"
  ADD COLUMN "birthdayEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "birthdayHeader" TEXT NOT NULL DEFAULT '¡Feliz cumpleaños!',
  ADD COLUMN "birthdayBody" TEXT NOT NULL DEFAULT '¡Feliz cumpleaños! Disfruta de un 10% de descuento en nuestros servicios. Esperamos verte pronto.',
  ADD COLUMN "birthdayNotify" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "birthdayLastRunDate" TEXT;
