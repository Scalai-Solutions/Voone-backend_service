-- The history label of a visit, so one that earns no points (medicine) still shows what it was.
ALTER TABLE "PaidVisit" ADD COLUMN "reason" TEXT;
