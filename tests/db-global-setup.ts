import { execFileSync } from "node:child_process";

import dotenv from "dotenv";

import { assertLocalDatabaseUrl } from "./assert-local-database";

/**
 * Brings the test database up to date before any suite runs.
 *
 * A developer's own .env wins; the fallbacks only fill what it does not set and match
 * docker-compose.yml, so following the README needs no extra configuration. PORT,
 * REDIS_URL and FRONTEND_URL are filled because src/config/env.ts throws at import time —
 * without them, any test that transitively imports config dies during collection with an
 * error that points nowhere near the cause.
 */
export default function setup(): void {
  dotenv.config();

  process.env.DATABASE_URL ??= "postgresql://voone:voone@localhost:5432/voone?schema=public";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.PORT ??= "4000";
  process.env.FRONTEND_URL ??= "http://localhost:3000";

  // Checked after the fallbacks are applied and before anything touches the database: a
  // developer's .env wins over those fallbacks, so a .env pointed at a hosted database
  // would otherwise be migrated, seeded and written to by the suite.
  assertLocalDatabaseUrl(process.env.DATABASE_URL);

  try {
    // deploy, not dev: dev is interactive and would prompt or reset in CI.
    execFileSync("npx", ["prisma", "migrate", "deploy"], { stdio: "pipe" });
    // Idempotent, and CI starts from an empty database — without it the suite could not
    // assert that a fresh environment can serve a QR code.
    execFileSync("npx", ["prisma", "db", "seed"], { stdio: "pipe" });
  } catch (error) {
    throw new Error(
      "Could not prepare the test database. Start it with `docker compose up -d`, or " +
        `point DATABASE_URL at a reachable Postgres. Original error: ${String(error)}`
    );
  }
}
