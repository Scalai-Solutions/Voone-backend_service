import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

const HEADER = "x-voone-edge";

const matches = (received: string, expected: string): boolean => {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch, which is itself not secret.
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Rejects requests that did not arrive through the edge.
 *
 * Railway exposes a *.up.railway.app hostname that bypasses Cloudflare entirely. Without
 * this guard an attacker reaches the origin directly, forges CF-Connecting-IP, and mints
 * an unlimited supply of rate-limit buckets — which makes both the edge WAF rules and the
 * in-process limiter theater.
 *
 * Opt-in: with no secret configured this is a no-op, so local development and CI are
 * unaffected and a misconfigured deploy fails open rather than locking everyone out.
 * That trade is deliberate — the alternative is an outage on a forgotten variable.
 */
export const createRequireEdge = (secret: string | undefined): RequestHandler => {
  if (!secret) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const received = req.headers[HEADER];

    if (typeof received === "string" && matches(received, secret)) {
      next();

      return;
    }

    res.status(403).json({ code: "FORBIDDEN", message: "Forbidden" });
  };
};
