import type { Request, RequestHandler } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface FixedWindowOptions {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /** Derives the bucket key. Attacker-controlled, hence the sweep below. */
  key: (req: Request) => string;
  /** Bucket count above which expired entries are swept. */
  maxBuckets?: number;
}

export type FixedWindowLimiter = RequestHandler & { bucketCount: () => number };

/**
 * In-memory fixed-window rate limiter.
 *
 * Correct only while the service runs a single replica, which is Railway's default. Two
 * honest failure modes to know before scaling: the counters reset on every deploy, and
 * with N replicas the effective limit silently becomes N times the configured one. Move
 * this to Redis before raising the replica count.
 *
 * Deliberately dependency-free. express-rate-limit would do the same job, but a new
 * runtime dependency means a package-lock conflict with every branch in flight, and the
 * logic that matters here is twenty lines.
 */
export const createFixedWindowLimiter = (options: FixedWindowOptions): FixedWindowLimiter => {
  const maxBuckets = options.maxBuckets ?? 10_000;
  const buckets = new Map<string, Bucket>();

  const handler: RequestHandler = (req, res, next) => {
    const now = Date.now();

    // The key is attacker-controlled, so an unswept map is itself a memory exhaustion
    // vector — the limiter would become the denial of service it exists to prevent.
    if (buckets.size > maxBuckets) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) {
          buckets.delete(key);
        }
      }
    }

    const key = options.key(req);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();

      return;
    }

    bucket.count += 1;

    if (bucket.count > options.limit) {
      res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
      res.status(429).json({
        code: "RATE_LIMITED",
        message: "Demasiados intentos. Inténtalo de nuevo en unos minutos."
      });

      return;
    }

    next();
  };

  return Object.assign(handler, { bucketCount: () => buckets.size });
};
