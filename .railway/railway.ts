import { defineRailway, github, preserve, project, redis, ref, service } from "railway/iac";

// A per-service partial, matching voone-web's file. Its note about preferring one
// project-level file still applies: when these are combined, this and voone-web's
// partial become two `service()` calls in a single definition.
export const partial = "voone-backend";

export default defineRailway(() => {
  // Managed Redis, declared here rather than clicked into the dashboard so REDIS_URL can
  // be a reference instead of a pasted connection string that nobody dares rotate.
  //
  // Until this exists, REDIS_URL held a placeholder that satisfied the config validator
  // and pointed at nothing — which was harmless only because nothing read it. The wallet
  // sync queue now does, so a placeholder would become a runtime failure the moment
  // WALLET_SYNC_MODE moved off "inline".
  const cache = redis("voone-redis");

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

      // A reference, not a preserved value: Railway keeps it correct across a Redis
      // rotation or rebuild, and there is no copied credential to go stale.
      REDIS_URL: ref(cache, "REDIS_URL"),

      STAFF_API_KEY: preserve(),

      // Optional in src/config/env.ts but declared here anyway. Anything this file does
      // not name is DESTROYED by an apply, so an undeclared optional is not "left alone",
      // it is deleted — which would silently switch the edge guard off.
      EDGE_SHARED_SECRET: preserve(),
      GOOGLE_WALLET_ISSUER_ID: preserve(),
      GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: preserve(),
      GOOGLE_WALLET_SERVICE_ACCOUNT_KEY: preserve(),
      GOOGLE_WALLET_ALLOWED_ORIGIN: preserve(),
      // --- Apple Wallet signing ---
      // The pass type and team identifiers are read from the certificate itself, so only
      // the material is configured. All preserved: three of them are private keys or
      // certificates and none belongs in git.
      APPLE_WALLET_ORGANIZATION_NAME: preserve(),
      APPLE_WALLET_SIGNER_CERT_BASE64: preserve(),
      APPLE_WALLET_SIGNER_KEY_BASE64: preserve(),
      APPLE_WALLET_SIGNER_KEY_PASSPHRASE: preserve(),
      APPLE_WALLET_WWDR_CERT_BASE64: preserve(),

      // Baked into every signed pass and unchangeable afterwards: a pass on a member's
      // phone calls this host forever. Preserved rather than pinned so it cannot be
      // changed by editing this file without someone thinking about it first.
      APPLE_PASS_WEB_SERVICE_URL: preserve(),

      // Keys the HMAC behind every member's barcode. Rotating it changes every issued
      // barcode at once.
      CARD_REDEMPTION_SECRET: preserve(),

      // --- Wallet sync ---
      // "queue" now that voone-redis exists and REDIS_URL resolves to it over private
      // networking. Inline was never meant to be the destination: it runs the provider
      // fan-out inside the request, so a slow Apple or Google call is latency the member
      // waits for at the sign-up form, and a failed one is lost the moment the response
      // is sent. The queue gives it retries with backoff and survives a redeploy.
      //
      // This is deliberately a separate apply from the one that created the instance: a
      // service booting against a queue still being provisioned fails for a reason nobody
      // enjoys diagnosing.
      WALLET_SYNC_MODE: "queue",

      // The API consumes the queue itself. Set false only once a dedicated worker service
      // running `npm run worker` exists, or nothing consumes and every card goes stale.
      WALLET_WORKER_IN_PROCESS: "true",

      // Environment-specific, so preserved rather than pinned here.
      FRONTEND_URL: preserve(),
      // Not a secret and not environment-specific: src/config/env.ts requires it at import,
      // so a missing value is a boot failure rather than a degraded feature.
      PORT: "4000"
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
    resources: [api, cache]
  });
});
