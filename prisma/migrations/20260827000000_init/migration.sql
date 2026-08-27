-- CreateTable
CREATE TABLE "Health" (
    "id" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Health_pkey" PRIMARY KEY ("id")
);