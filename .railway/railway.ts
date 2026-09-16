import { defineRailway, project, service } from "railway/iac";

// A per-service partial, matching voone-web's file. Its note about preferring one
// project-level file still applies: when these are combined, this and voone-web's
// partial become two `service()` calls in a single definition.
export const partial = "voone-backend";

export default defineRailway(() => {
  const api = service("voone-backend", {
    build: "npm run build",
    start: "npm start",

    // Railway's default health check requests "/", which this API does not serve — every
    // deploy would be marked unhealthy and rolled back. /api/v1/health needs no database,
    // so it answers even when DATABASE_URL is wrong, which is what makes it a liveness
    // check rather than a readiness one.
    healthcheckPath: "/api/v1/health",

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
