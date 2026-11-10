-- What the client paid, medicine included. Existing rows only know what earned progress, so
-- they start from that (a past medicine-only visit stays at 0). The default keeps a backend
-- deployed before this column existed able to record visits (they read 0 until it is updated).
ALTER TABLE "PaidVisit" ADD COLUMN "paidCents" INTEGER NOT NULL DEFAULT 0;
UPDATE "PaidVisit" SET "paidCents" = "amountCents";
