-- Give members without a stored tier the clinic's lowest configured tier.
-- The tier scale lives in ClinicTemplate.tierRewards JSON; the base tier is the row with
-- the smallest minLifetimePoints value, e.g. Bronze.
UPDATE "Member" AS member
SET "tier" = base_tier.name
FROM (
  SELECT template."clinicId", tier.value ->> 'name' AS name
  FROM "ClinicTemplate" AS template
  CROSS JOIN LATERAL (
    SELECT value
    FROM jsonb_array_elements(template."tierRewards"::jsonb) AS tier(value)
    WHERE tier.value ? 'name'
    ORDER BY COALESCE((tier.value ->> 'minLifetimePoints')::integer, 0) ASC
    LIMIT 1
  ) AS tier
) AS base_tier
WHERE member."clinicId" = base_tier."clinicId"
  AND member."erasedAt" IS NULL
  AND (member."tier" IS NULL OR member."tier" = '')
  AND base_tier.name IS NOT NULL
  AND base_tier.name <> '';
