-- Billing details for invoicing a centre: who and where the invoice goes. All optional, so a
-- centre that never filled them in is still billable by its commercial name and address.

ALTER TABLE "Clinic"
  ADD COLUMN "billingName" TEXT,
  ADD COLUMN "billingTaxId" TEXT,
  ADD COLUMN "billingEmail" TEXT,
  ADD COLUMN "billingAddressLine" TEXT,
  ADD COLUMN "billingPostalCode" TEXT;