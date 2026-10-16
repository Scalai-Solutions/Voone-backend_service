-- Store the full date of birth for sign-ups going forward.
-- Existing birthYear values cannot honestly produce a day/month, so they stay as the
-- fallback used by the dashboard when birthDate is null.
ALTER TABLE "Member" ADD COLUMN "birthDate" DATE;
