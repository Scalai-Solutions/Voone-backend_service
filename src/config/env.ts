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

  EDGE_SHARED_SECRET: z.string().min(16, "EDGE_SHARED_SECRET must be at least 16 chars").optional()
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
