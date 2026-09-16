-- The three template presets, as a migration rather than a seed.
--
-- They are reference data: every environment needs them, nothing edits them per-tenant, and
-- a clinic cannot create a template without one. They were previously seeded by
-- `prisma db seed`, which runs tsx — a devDependency — so it fails on a production install
-- where dev dependencies are pruned. A deployment therefore came up with no presets and no
-- clinics, and every sign-up answered 404 until someone remembered a manual step.
--
-- As a migration they are applied by `prisma migrate deploy` in preDeploy, on every
-- environment, with nothing to remember. The demo clinics stay in the seed, because seeding
-- fictional clinics into production was never right — real ones need a provisioning flow.
--
-- ON CONFLICT DO NOTHING so this is safe where the seed has already inserted them, and
-- so re-running never overwrites a hexBackgroundColor a clinic is already using.
--
-- The id is supplied explicitly: Prisma's uuid() default is generated client-side, so the
-- column itself has no default. The cast is needed because the column is TEXT.
INSERT INTO "TemplatePreset" ("id", "name", "hexBackgroundColor")
VALUES
  (gen_random_uuid()::text, 'Classic Gold', '#ead0bd'),
  (gen_random_uuid()::text, 'Modern Dark', '#2a2e35'),
  (gen_random_uuid()::text, 'Fresh Mint', '#d8efe3')
ON CONFLICT ("name") DO NOTHING;
