-- A visit recorded by mistake is voided, not deleted: the row stays as the record of what was
-- entered, and every read of a client's visits skips it.
ALTER TABLE "PaidVisit"
    ADD COLUMN "voidedAt" TIMESTAMP(3),
    ADD COLUMN "voidedBy" TEXT,
    ADD COLUMN "voidReason" TEXT;
