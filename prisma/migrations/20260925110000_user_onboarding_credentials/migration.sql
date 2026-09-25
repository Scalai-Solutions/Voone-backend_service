ALTER TABLE "User"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "passwordHash" TEXT,
  ADD COLUMN "onboardingPasswordGeneratedAt" TIMESTAMP(3),
  ADD COLUMN "onboardingCredentialsSentAt" TIMESTAMP(3);