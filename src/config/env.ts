import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const booleanEnv = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const timeZoneEnv = z
  .string()
  .default("Europe/Madrid")
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: "must be a valid IANA time zone" }
  );

/**
 * A variable that may be left blank. An empty string (`BUNNY_STORAGE_ZONE=` in a hosting
 * panel, or a compose file's unset substitution) means "not configured", not "invalid", so
 * the app still boots and the feature reports itself as unconfigured.
 */
const blankIsUnset = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const httpsUrlWithoutTrailingSlash = (name: string) =>
  z
    .string()
    .url(`${name} must be a valid URL`)
    .refine((value) => value.startsWith("https://"), { message: `${name} must be an https URL` })
    .transform((value) => value.replace(/\/+$/, ""));

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  PORT: z.coerce.number().int().positive("PORT must be a positive integer"),
  FRONTEND_URL: z.string().url("FRONTEND_URL must be a valid URL"),

  // Optional on purpose. Set it, and a matching Cloudflare Transform Rule, to reject
  // requests that reach the Railway origin directly and bypass the edge. Unset, the
  // guard is a no-op, so local development and CI need no extra configuration and a
  // deploy that forgets it fails open rather than locking every clinic out.
  // Optional on purpose, like EDGE_SHARED_SECRET. Set it, and give the same value to the
  // dashboard's server-side route handlers, to require authentication on template writes
  // and to distinguish staff sign-ups from anonymous ones. Unset, those checks are no-ops,
  // so local development and CI need no configuration.
  //
  // It must never be exposed to a browser: it is a bearer credential for the whole staff
  // surface, so it belongs only in server-side code.
  STAFF_API_KEY: z.string().min(24, "STAFF_API_KEY must be at least 24 chars").optional(),

  EDGE_SHARED_SECRET: z.string().min(16, "EDGE_SHARED_SECRET must be at least 16 chars").optional(),

  /**
   * Whether the Google Wallet account is out of Demo Mode.
   *
   * Configured rather than derived because Google exposes no API that reports it: the
   * status is granted by a human at Google (VOO-3) and there is nothing to query. The
   * default is "demo" deliberately — claiming "live" on an unconfigured environment would
   * tell the admin panel that real members can save cards when they cannot.
   */
  GOOGLE_WALLET_PUBLISHING_STATUS: z.enum(["demo", "live"]).default("demo"),

  // Optional, and read at startup rather than at first use, because whether the Apple
  // pass web service is mounted at all depends on it. Without a certificate there is no
  // pass to update, and routes that 500 on every call are worse than routes that 404.
  //
  // Apple appends "/v1/..." to this, and the pass routes live under the existing /api/v1
  // router — so it stops at /api. It is baked into every signed pass and cannot be
  // changed afterwards: a pass on a member's phone calls this host forever. Never a
  // deploy-scoped hostname.
  APPLE_PASS_WEB_SERVICE_URL: z
    .string()
    .url("APPLE_PASS_WEB_SERVICE_URL must be a valid URL")
    .optional(),

  // Optional. Keys the HMAC that derives each member's barcode. Rotating it changes every
  // issued barcode at once, which is the argument for eventually storing the code per
  // member instead.
  CARD_REDEMPTION_SECRET: z
    .string()
    .min(24, "CARD_REDEMPTION_SECRET must be at least 24 chars")
    .optional(),

  // How a points change reaches the wallets.
  //
  // "inline" runs the sync in the API process: no retries, no durability, and a restart
  // loses anything in flight. It is the default because it needs no infrastructure and
  // the call sites are identical either way — moving to "queue" is configuration, not
  // code.
  //
  // "queue" uses Redis and BullMQ, and needs the worker process running
  // (`npm run worker`). Setting it without a worker means jobs pile up and no card ever
  // updates, which is why the worker exits loudly rather than idling when the mode is
  // wrong.
  WALLET_SYNC_MODE: z.enum(["inline", "queue"]).default("inline"),

  // Whether the API process also consumes the queue, rather than only enqueueing onto it.
  //
  // True by default, because a durable queue with nobody consuming it is worse than no
  // queue at all: jobs accumulate, every card goes stale, and nothing looks broken. One
  // Redis instance and no second deploy is the right trade at pilot scale.
  //
  // Set it false on the API when a dedicated worker service exists (`npm run worker`) —
  // at that point pass signing should stop competing with request handling for the event
  // loop, which is the only reason to separate them.
  WALLET_WORKER_IN_PROCESS: booleanEnv,

  // Birthday automation schedule. Defaults to once daily at 09:00 Europe/Madrid. Lowering
  // the frequency makes the scheduler wake more often, but a member still receives at most
  // one birthday message per clinic day because the job is idempotent by date.
  BIRTHDAY_NOTIFICATION_CRON_ENABLED: booleanEnv,
  BIRTHDAY_NOTIFICATION_TIME_ZONE: timeZoneEnv,
  BIRTHDAY_NOTIFICATION_HOUR: z.coerce.number().int().min(0).max(23).default(9),
  BIRTHDAY_NOTIFICATION_MINUTE: z.coerce.number().int().min(0).max(59).default(0),
  BIRTHDAY_NOTIFICATION_FREQUENCY_MINUTES: z.coerce.number().int().min(1).max(1440).default(1440),

  // Optional in code, but set it to a public HTTPS URL in production. It is the plain Voone
  // logo used on a wallet card when a clinic has not set its own, and what activation and the
  // admin list treat as "no logo of its own". Unset, such a card is sent to Google without a
  // logo, and Google may reject a class created that way: those clinics are then created but
  // stay "google_pending" until they have a logo of their own.
  VOONE_DEFAULT_LOGO_URL: z.string().url("VOONE_DEFAULT_LOGO_URL must be a valid URL").optional(),

  // Image uploads (logo, dark-background logo, hero) are stored in Bunny.net and served from
  // its pull zone, because Apple and Google both need a public https image URL. All optional:
  // without the zone, the key and the public base URL the upload routes answer 503 and the
  // rest of the app is unaffected.
  //
  // The zone name goes into the request path, so it is restricted to what Bunny allows.
  BUNNY_STORAGE_ZONE: z.preprocess(
    blankIsUnset,
    z
      .string()
      .regex(/^[A-Za-z0-9-]+$/, "BUNNY_STORAGE_ZONE must contain only letters, digits and hyphens")
      .optional()
  ),
  // The regional storage endpoint; Frankfurt is Bunny's default region.
  BUNNY_STORAGE_ENDPOINT: z.preprocess(
    blankIsUnset,
    httpsUrlWithoutTrailingSlash("BUNNY_STORAGE_ENDPOINT").default("https://storage.bunnycdn.com")
  ),
  // The storage zone's WRITE password (not the read-only one). A bearer credential for the
  // whole zone: server-side only, never logged, never returned.
  BUNNY_STORAGE_ACCESS_KEY: z.preprocess(blankIsUnset, z.string().min(1).optional()),
  // Where the files are publicly served from: the pull zone linked to the storage zone.
  BUNNY_PUBLIC_BASE_URL: z.preprocess(
    blankIsUnset,
    httpsUrlWithoutTrailingSlash("BUNNY_PUBLIC_BASE_URL").optional()
  ),

  SENDGRID_API_KEY: z.string().min(1).optional(),
  SENDGRID_FROM_EMAIL: z.string().email("SENDGRID_FROM_EMAIL must be a valid email").optional()
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const details = parsedEnv.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  throw new Error(`Invalid environment configuration: ${details}`);
}

export const config = parsedEnv.data;

export type Config = typeof config;
