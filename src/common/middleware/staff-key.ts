import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";

const HEADER = "x-voone-staff-key";

const matches = (received: string, expected: string): boolean => {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch, which is not itself secret.
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Whether a request proves it came from the staff surface.
 *
 * **Strict**: with no key configured nobody qualifies. The asymmetry against
 * createRequireStaffKey below is deliberate — this answer is used to waive the public
 * rate limit, and a deployment that forgot the variable must not thereby switch off abuse
 * protection for everyone. Permissiveness where a missing key is merely inconvenient is
 * one thing; permissiveness that disables a control is another.
 *
 * The key must never reach a browser. The dashboard calls its own Next route handler,
 * which holds it server-side and derives the clinic from the session rather than the
 * request, so a staff caller cannot act on a clinic that is not theirs.
 */
export const isStaffRequest = (req: Request, secret: string | undefined): boolean => {
  if (!secret) {
    return false;
  }

  const received = req.headers[HEADER];

  return typeof received === "string" && matches(received, secret);
};

/** Whether staff authentication is configured at all. */
export const isStaffKeyConfigured = (secret: string | undefined): boolean => Boolean(secret);

/**
 * Rejects a write that does not carry the staff key.
 *
 * Template writes decide what a clinic's public sign-up page looks like — its name and
 * its colours — so without this, anyone able to reach the API can deface that page.
 *
 * A no-op when no key is configured, so local development and CI need none. That is the
 * same fail-open trade as requireEdge: a forgotten variable leaves a gap that already
 * existed rather than breaking every clinic's dashboard.
 */
export const createRequireStaffKey = (secret: string | undefined): RequestHandler => {
  if (!secret) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    if (isStaffRequest(req, secret)) {
      next();

      return;
    }

    res.status(403).json({ code: "FORBIDDEN", message: "Forbidden" });
  };
};

/**
 * Like createRequireStaffKey, but closed when it matters: with no key configured, production
 * refuses every request (503) instead of letting everyone in. Outside production it is the
 * permissive guard, so local development and CI need no key.
 *
 * For routes that trust headers the staff key vouches for (a role, a person), where an open
 * door is not a gap that already existed but a way to act as an admin.
 */
export const createRequireStaffKeyInProduction = (
  secret: string | undefined,
  production: boolean
): RequestHandler => {
  if (secret || !production) return createRequireStaffKey(secret);

  return (_req, res) => {
    res.status(503).json({ code: "STAFF_KEY_NOT_CONFIGURED", message: "Service unavailable" });
  };
};
