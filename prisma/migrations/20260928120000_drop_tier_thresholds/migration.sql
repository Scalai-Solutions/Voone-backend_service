-- TierThreshold is removed in favour of ClinicTemplate.tierRewards.
--
-- There were two models of one concept: this table, which the tier engine queried, and
-- the tierRewards JSON the onboarding wizard actually writes. Nothing ever populated the
-- table, so every card showed no tier while the wizard appeared to have configured five.
--
-- Safe to drop rather than migrate: the table is empty in every environment, because no
-- code path has ever inserted into it.

DROP TABLE IF EXISTS "TierThreshold";
