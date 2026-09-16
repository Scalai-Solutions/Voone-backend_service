import { Router } from "express";

import { MembershipValidationError } from "../../common/errors/membership.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createFixedWindowLimiter } from "../../common/middleware/rate-limit";
import { createRequireEdge } from "../../common/middleware/require-edge";
import { clientIp } from "../../common/utils/client-ip";
import { config } from "../../config/env";
import { prisma } from "../../infrastructure/database/prisma-client";
import { findClinicBySlug } from "../../modules/clinics/clinic.service";
import { membershipSignupSchema } from "../../modules/members/membership.schema";
import { signUpMember } from "../../modules/members/membership.service";

export const membersRouter = Router();

/**
 * Ten per address per clinic per ten minutes. Spanish carriers use CGNAT, so many
 * genuine sign-ups share one address and a tighter per-IP limit would block a real
 * reception desk. The clinic is part of the key so one clinic's traffic, legitimate or
 * not, cannot exhaust another's allowance.
 */
const signUpLimiter = createFixedWindowLimiter({
  limit: 10,
  windowMs: 10 * 60 * 1000,
  key: (req) => `${clientIp(req)}:${req.params.slug}`
});

// Applied per route rather than to the whole router: Railway's health check reaches the
// origin directly, so guarding /health on an edge header would fail every probe.
const requireEdge = createRequireEdge(config.EDGE_SHARED_SECRET);

membersRouter.post(
  "/clinics/:slug/members",
  requireEdge,
  signUpLimiter,
  asyncHandler(async (req, res) => {
    // The clinic is resolved before the body is validated: an unknown slug is a 404
    // whatever was submitted, and there is no point reporting field errors for a clinic
    // that does not exist.
    const clinic = await findClinicBySlug(prisma, req.params.slug);

    const parsed = membershipSignupSchema.safeParse(req.body);

    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");

      throw new MembershipValidationError(details);
    }

    // The default lives here rather than in the schema or the service: it is an API
    // default, so an omitted field means the public form, while the staff surface states
    // itself explicitly.
    await signUpMember(prisma, clinic, parsed.data, parsed.data.consentSource ?? "qr_signup");

    // Byte-identical whether the member was created or already existed. A 201/200
    // distinction would tell anyone who can POST whether a given phone number belongs
    // to a member of a named aesthetic clinic; echoing the stored name would be worse
    // still, because a foreign visitor's national number can normalize onto an existing
    // Spanish member and would show her a stranger's record. Nothing here needs an id.
    res.status(200).json({ status: "ok" });
  })
);
