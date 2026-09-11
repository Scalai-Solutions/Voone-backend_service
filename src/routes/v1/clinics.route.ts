import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler";
import { prisma } from "../../infrastructure/database/prisma-client";
import { findClinicBySlug, toPublicClinic } from "../../modules/clinics/clinic.service";

export const clinicsRouter = Router();

/**
 * Resolves the slug on a QR poster to the branding the sign-up form renders with.
 *
 * Read-only and public: the form has to show the clinic's name before anyone submits
 * anything, and hardcoding the list in the frontend would mean a deploy per new clinic.
 */
clinicsRouter.get(
  "/clinics/:slug",
  asyncHandler(async (req, res) => {
    const clinic = await findClinicBySlug(prisma, req.params.slug);

    res.json({ clinic: toPublicClinic(clinic) });
  })
);
