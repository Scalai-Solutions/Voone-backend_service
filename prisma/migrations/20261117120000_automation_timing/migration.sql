-- Per-clinic timing thresholds for automations (e.g. {"inactiveDays": 14}). Null or a missing
-- key reads as the catalog default, so existing rows need no backfill.
ALTER TABLE "ClinicAutomation" ADD COLUMN "timing" JSONB;
