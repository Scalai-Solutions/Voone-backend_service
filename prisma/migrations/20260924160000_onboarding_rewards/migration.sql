ALTER TABLE "ClinicTreatment" ADD COLUMN "priceEuro" INTEGER;

ALTER TABLE "ClinicTemplate"
  ADD COLUMN "tierRewards" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "milestoneRewards" JSONB NOT NULL DEFAULT '{"milestoneCount":10,"pointsToNextMilestone":2000,"priceAmount":10,"pointsAwarded":100}';