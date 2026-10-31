-- Additive: further wallet buttons beside the main one. Existing templates get an empty list.
ALTER TABLE "ClinicTemplate" ADD COLUMN "extraButtons" JSONB NOT NULL DEFAULT '[]';
