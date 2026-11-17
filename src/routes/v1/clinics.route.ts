import { Router } from "express";

import { ClinicNotFoundError } from "../../common/errors/membership.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { prisma } from "../../infrastructure/database/prisma-client";
import { findClinicBySlug, toPublicClinic } from "../../modules/clinics/clinic.service";
import { findClubPage } from "../../modules/clinics/club.service";

export const clinicsRouter = Router();

/**
 * Resolves the public key on a QR poster to the branding the sign-up form renders with.
 * New posters use clinic UUIDs; old slug posters still resolve.
 *
 * Read-only and public: the form has to show the clinic's own name and colour before
 * anyone submits anything, and hardcoding the list in the frontend would mean a deploy
 * per new clinic.
 */
clinicsRouter.get(
  "/clinics/:slug",
  asyncHandler(async (req, res) => {
    const clinic = await findClinicBySlug(prisma, req.params.slug);

    // No template means no branding, and an unbranded page is worse than an honest 404.
    if (!clinic.template) {
      throw new ClinicNotFoundError(req.params.slug);
    }

    res.json({ clinic: toPublicClinic(clinic, clinic.template) });
  })
);

/**
 * The club page's data: the clinic's branding plus what its live programme gives a client, read
 * from the same programme the wallet card reads. Public and read-only. A clinic with no live
 * programme is a 404, like an unknown one.
 */
clinicsRouter.get(
  "/clinics/:slug/club",
  asyncHandler(async (req, res) => {
    res.json(await findClubPage(prisma, req.params.slug));
  })
);
