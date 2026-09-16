import { defineRailway, github, preserve, project, service } from "railway/iac";

// A per-service partial, matching voone-web's file. Its note about preferring one
// project-level file still applies: when these are combined, this and voone-web's
// partial become two `service()` calls in a single definition.
export const partial = "voone-backend";

export default defineRailway(() => {
  const api = service("voone-backend", {
    // Built from the repository rather than an uploaded snapshot, so a deploy is
    // reproducible from a commit and pushes to main deploy themselves.
    source: github("Scalai-Solutions/Voone-backend_service"),

    build: "npm run build",
    start: "npm start",

    // Railway's default health check requests "/", which this API does not serve — every
    // deploy would be marked unhealthy and rolled back. /api/v1/health needs no database,
    // so it answers even when DATABASE_URL is wrong, which is what makes it a liveness
    // check rather than a readiness one.
    healthcheckPath: "/api/v1/health",

    // Every variable the service needs is named here, because this file is authoritative:
    // one that is not declared gets DELETED by `railway config apply`. Secrets are declared
    // as preserve(), which keeps whatever value Railway holds — so they are set once with
    // `railway variable set --stdin` and never committed, while an apply cannot wipe them.
    //
    // Found by running `railway config plan` before the first apply: it reported "9 to
    // destroy" against the variables that had just been set by hand.
    env: {
      DATABASE_URL: preserve(),
      REDIS_URL: preserve(),
      STAFF_API_KEY: preserve(),
      GOOGLE_WALLET_ISSUER_ID: preserve(),
      GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: preserve(),
      GOOGLE_WALLET_SERVICE_ACCOUNT_KEY: preserve(),
      GOOGLE_WALLET_ALLOWED_ORIGIN: preserve(),
      // Environment-specific, so preserved rather than pinned here.
      FRONTEND_URL: preserve(),
      // Not a secret and not environment-specific: src/config/env.ts requires it at import,
      // so a missing value is a boot failure rather than a degraded feature.
      PORT: "4000",
    },

    // Migrations run before the new version takes traffic, so the code and the schema can
    // never be live at different versions. `deploy`, not `dev`: dev is interactive and
    // would try to reset.
    //
    // This requires DATABASE_URL to point at Supabase's SESSION pooler (port 5432).
    // The transaction pooler (6543) cannot run DDL or hold the advisory lock Prisma takes,
    // so a deploy configured against it fails here rather than at runtime.
    preDeploy: "npx prisma migrate deploy"
  });

  // The existing project, so the API and the marketing site share one dashboard and one
  // set of shared variables rather than being split across two projects.
  return project("voone-web", {
    resources: [api]
  });
});
