import { Router } from "express";

import { MembershipValidationError } from "../../common/errors/membership.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import { prisma } from "../../infrastructure/database/prisma-client";
import { provisionClinicSchema } from "../../modules/clinics/clinic-provisioning.schema";
import {
  provisionClinic,
  toProvisionedSummary
} from "../../modules/clinics/clinic-provisioning.service";

export const adminClinicsRouter = Router();

/**
 * Onboards a clinic.
 *
 * Gated by the staff key, which proves a request came from the Voone app rather than the
 * open internet. It does NOT prove the caller is an administrator: that check lives in the
 * frontend's route handler, which requires a voone_admin session before calling this.
 *
 * Worth being explicit that this is the same key the dashboard uses for ordinary member
 * entry, so anything holding it can create a clinic. Separating an admin credential from a
 * staff one is the next step; a second key is only worth adding once there is a second
 * kind of holder.
 */
adminClinicsRouter.post(
  "/admin/clinics",
  createRequireStaffKey(config.STAFF_API_KEY),
  asyncHandler(async (req, res) => {
    const parsed = provisionClinicSchema.safeParse(req.body);

    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");

      throw new MembershipValidationError(details);
    }

    const provisioned = await provisionClinic(prisma, parsed.data);

    res.status(201).json(toProvisionedSummary(provisioned));
  })
);
