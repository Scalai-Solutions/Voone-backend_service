-- Lifetime points, cached alongside pointsBalance for the same reason: a pass is
-- rebuilt on issue, on every sync and on every device fetch, and a member with years of
-- visits must not cost a full ledger scan each time.
--
-- Defaults to 0 for existing rows rather than being computed here. The ledger is the
-- source of truth and `npm run points:recompute` fills this in from it — doing the sum
-- in a migration would duplicate that logic in SQL, where it could drift.

ALTER TABLE "Member" ADD COLUMN "lifetimePoints" INTEGER NOT NULL DEFAULT 0;
