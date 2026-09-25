ALTER TABLE "Clinic"
  ADD COLUMN "voonePlan" TEXT NOT NULL DEFAULT 'starter',
  ADD COLUMN "notificationsMonthlyQuota" INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN "notificationsUsedThisMonth" INTEGER NOT NULL DEFAULT 0;