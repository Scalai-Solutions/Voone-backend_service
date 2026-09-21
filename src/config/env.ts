import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

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
  WALLET_SYNC_MODE: z.enum(["inline", "queue"]).default("inline")
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
