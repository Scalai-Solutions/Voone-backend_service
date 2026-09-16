/**
 * Refuses to run the suite against a database that is not local.
 *
 * The suite is destructive by design: the global setup runs `prisma migrate deploy` and
 * `prisma db seed`, and the integration tests create and delete rows to exercise the unique
 * index and the concurrent sign-up race. Pointed at a shared database — a Supabase project,
 * say — that is a migration and a data loss, not a test run.
 *
 * This is needed because the global setup calls `dotenv.config()` before applying its
 * localhost fallbacks, so a developer's own `.env` wins. A `.env` switched to a hosted
 * database for `npm run dev` silently re-targets the whole suite at it.
 */
const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
  "host.docker.internal"
]);

export const OVERRIDE_VARIABLE = "ALLOW_REMOTE_TEST_DATABASE";

export const assertLocalDatabaseUrl = (
  rawUrl: string | undefined,
  override: string | undefined = process.env[OVERRIDE_VARIABLE]
): void => {
  if (override === "true") {
    return;
  }

  if (!rawUrl) {
    throw new Error("DATABASE_URL is not set, so the test database cannot be verified as local.");
  }

  let hostname: string;

  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    // An unparseable URL is not demonstrably local, and the likeliest cause is an
    // unencoded "@" in the password — which also breaks libpq.
    throw new Error(
      "DATABASE_URL could not be parsed, so it cannot be verified as local. If the password " +
        'contains "@", percent-encode it as %40.'
    );
  }

  // An empty hostname means a unix socket, which is necessarily local.
  if (hostname === "" || LOCAL_HOSTNAMES.has(hostname)) {
    return;
  }

  throw new Error(
    `Refusing to run the test suite against "${hostname}". The suite runs prisma migrate ` +
      `deploy, prisma db seed, and tests that create and delete rows, so a non-local database ` +
      `would be migrated and written to.\n\n` +
      `Start a local database with \`docker compose up -d\` and point DATABASE_URL at it, or ` +
      `set ${OVERRIDE_VARIABLE}=true for a single run if that is genuinely what you want.`
  );
};
