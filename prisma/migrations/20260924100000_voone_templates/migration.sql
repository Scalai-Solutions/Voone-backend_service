CREATE TABLE "VooneTemplate" (
    "id" TEXT NOT NULL,
    "presetId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "programName" TEXT NOT NULL,
    "hexBackgroundColor" TEXT NOT NULL,
    "logoUrl" TEXT,
    "heroImageUrl" TEXT,
    "pointsLabel" TEXT NOT NULL,
    "tierLabel" TEXT NOT NULL,
    "benefitsText" TEXT,
    "infoText" TEXT,
    "buttons" JSONB NOT NULL DEFAULT '[]',
    "textModules" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VooneTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VooneTemplate_presetId_idx" ON "VooneTemplate"("presetId");

ALTER TABLE "VooneTemplate"
  ADD CONSTRAINT "VooneTemplate_presetId_fkey"
  FOREIGN KEY ("presetId") REFERENCES "TemplatePreset"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;