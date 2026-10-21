-- When the person accepted the processing of their data on the QR sign-up form.
ALTER TABLE "Member" ADD COLUMN "privacyAcceptedAt" TIMESTAMP(3);
