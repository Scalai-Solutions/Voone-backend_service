-- The centre's "Prize (Y/N)" answer per catalogue row. Null: never answered.
ALTER TABLE "CatalogItem" ADD COLUMN "prizeEligible" BOOLEAN;
