-- CreateTable
CREATE TABLE "TemplateChange" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "changedBy" TEXT,
    "changedFields" TEXT[],
    "cardsAtSave" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TemplateChange_clinicId_createdAt_idx" ON "TemplateChange"("clinicId", "createdAt");

-- CreateIndex
CREATE INDEX "TemplateChange_templateId_idx" ON "TemplateChange"("templateId");
