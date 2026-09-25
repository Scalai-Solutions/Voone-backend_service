-- The points ledger. Append-only by construction and by convention: there is no
-- updatedAt and no soft-delete column, and nothing in the application updates or deletes
-- a row. See docs/superpowers/specs/2026-09-25-points-ledger-design.md.

CREATE TYPE "PointsTransactionKind" AS ENUM ('EARN', 'REDEEM', 'ADJUSTMENT', 'REFERRAL', 'EXPIRY');

CREATE TABLE "PointsTransaction" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "kind" "PointsTransactionKind" NOT NULL,
    "reason" TEXT,
    "sourceRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "PointsTransaction_pkey" PRIMARY KEY ("id")
);

-- A zero-point movement is never meaningful, and the sign has to agree with the kind.
-- "A REDEEM that added points" is exactly the sort of bug that stays invisible until
-- someone audits a balance, so the database refuses it rather than trusting every future
-- caller to get it right.
ALTER TABLE "PointsTransaction" ADD CONSTRAINT "PointsTransaction_points_sign_matches_kind"
    CHECK (
        "points" <> 0
        AND (
            ("kind" IN ('EARN', 'REFERRAL') AND "points" > 0)
            OR ("kind" IN ('REDEEM', 'EXPIRY') AND "points" < 0)
            OR "kind" = 'ADJUSTMENT'
        )
    );

CREATE UNIQUE INDEX "PointsTransaction_idempotencyKey_key" ON "PointsTransaction"("idempotencyKey");
CREATE INDEX "PointsTransaction_memberId_createdAt_idx" ON "PointsTransaction"("memberId", "createdAt");
CREATE INDEX "PointsTransaction_clinicId_createdAt_idx" ON "PointsTransaction"("clinicId", "createdAt");

ALTER TABLE "PointsTransaction" ADD CONSTRAINT "PointsTransaction_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PointsTransaction" ADD CONSTRAINT "PointsTransaction_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ON DELETE RESTRICT, deliberately. Erasure overwrites a Member in place rather than
-- deleting it (see Member.erasedAt), so a delete reaching this table would mean someone
-- had bypassed that path — and taking the ledger with it would destroy the clinic's
-- metrics along with the member.

CREATE TABLE "TierThreshold" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "minLifetimePoints" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TierThreshold_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TierThreshold" ADD CONSTRAINT "TierThreshold_minLifetimePoints_not_negative"
    CHECK ("minLifetimePoints" >= 0);

CREATE UNIQUE INDEX "TierThreshold_clinicId_code_key" ON "TierThreshold"("clinicId", "code");
CREATE INDEX "TierThreshold_clinicId_minLifetimePoints_idx" ON "TierThreshold"("clinicId", "minLifetimePoints");

-- Postgres treats NULLs as distinct, so the unique index above does NOT constrain the
-- global rows: without this, two global defaults could share a code and the fallback
-- would resolve to whichever one the planner happened to return first.
CREATE UNIQUE INDEX "TierThreshold_global_code_key" ON "TierThreshold"("code") WHERE "clinicId" IS NULL;

ALTER TABLE "TierThreshold" ADD CONSTRAINT "TierThreshold_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
