-- Short-lived permission to download one member's pass, handed to the browser that just
-- created that member. The token is stored hashed: a claim URL ends up in browser
-- history, so the row must not be enough to mint a pass if the database leaks.

CREATE TABLE "PassClaim" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PassClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PassClaim_tokenHash_key" ON "PassClaim"("tokenHash");
CREATE INDEX "PassClaim_expiresAt_idx" ON "PassClaim"("expiresAt");

-- CASCADE, unlike the ledger's RESTRICT: a claim is disposable and carries no history
-- worth keeping, so it should disappear with the member rather than block anything.
ALTER TABLE "PassClaim" ADD CONSTRAINT "PassClaim_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
