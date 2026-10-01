-- The five-character number printed on a member's card and read aloud at reception.
--
-- Nullable, with no backfill here. Existing members get a code from
-- `npm run members:backfill-codes`, which generates one per member and retries its own
-- collisions; generating 28-million-to-one-unique values in SQL would mean reimplementing
-- the generator in a second place, where it could drift from the TypeScript one.
--
-- Postgres treats NULLs as distinct in a unique index, so this constraint is satisfiable
-- the moment it is created even though every existing row is NULL.
--
-- Unique per clinic rather than globally: every lookup is already clinic-scoped, and a
-- per-clinic namespace keeps five characters viable however many clinics Voone signs.

ALTER TABLE "Member" ADD COLUMN "code" TEXT;

CREATE UNIQUE INDEX "Member_clinicId_code_key" ON "Member"("clinicId", "code");
