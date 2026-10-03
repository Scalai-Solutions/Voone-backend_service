CREATE TYPE "NotificationType" AS ENUM ('BROADCAST', 'SEGMENT', 'SINGLE', 'POINTS', 'TIER');
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SENT', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED');
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DOWNGRADED', 'FAILED', 'SKIPPED');
CREATE TYPE "ClinicNotifyOnCredit" AS ENUM ('NEVER', 'MILESTONE_AND_TIER', 'ALWAYS');

CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "header" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "actionUrl" TEXT,
    "notify" BOOLEAN NOT NULL,
    "segmentJson" JSONB,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "scheduledAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerMessageId" TEXT,
        "idempotencyKey" TEXT,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "provider" "WalletProviderType" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "errorCode" TEXT,
    "sentAt" TIMESTAMP(3),
    "providerMessageId" TEXT,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClinicNotificationSettings" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "notifyOnCredit" "ClinicNotifyOnCredit" NOT NULL DEFAULT 'MILESTONE_AND_TIER',
    "marketingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicNotificationSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClinicLocation" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicLocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationAuditLog" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT,
    "clinicId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "recipientCount" INTEGER NOT NULL,
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Notification_clinicId_createdAt_idx" ON "Notification"("clinicId", "createdAt");
CREATE UNIQUE INDEX "Notification_clinicId_idempotencyKey_key" ON "Notification"("clinicId", "idempotencyKey");
CREATE INDEX "NotificationDelivery_notificationId_status_idx" ON "NotificationDelivery"("notificationId", "status");
CREATE INDEX "NotificationDelivery_memberId_idx" ON "NotificationDelivery"("memberId");
CREATE UNIQUE INDEX "ClinicNotificationSettings_clinicId_key" ON "ClinicNotificationSettings"("clinicId");
CREATE INDEX "ClinicLocation_clinicId_idx" ON "ClinicLocation"("clinicId");
CREATE INDEX "NotificationAuditLog_clinicId_createdAt_idx" ON "NotificationAuditLog"("clinicId", "createdAt");
CREATE INDEX "NotificationAuditLog_notificationId_idx" ON "NotificationAuditLog"("notificationId");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClinicNotificationSettings" ADD CONSTRAINT "ClinicNotificationSettings_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClinicLocation" ADD CONSTRAINT "ClinicLocation_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationAuditLog" ADD CONSTRAINT "NotificationAuditLog_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NotificationAuditLog" ADD CONSTRAINT "NotificationAuditLog_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;