-- A named, saved audience (the Audiencias tab): the segment criteria a centre reuses, stored
-- on the clinic so they survive a browser and the whole team sees the same list.

CREATE TABLE "ClinicAudience" (
  "id" TEXT NOT NULL,
  "clinicId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "criteria" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ClinicAudience_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClinicAudience_clinicId_idx" ON "ClinicAudience"("clinicId");

ALTER TABLE "ClinicAudience" ADD CONSTRAINT "ClinicAudience_clinicId_fkey"
  FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
