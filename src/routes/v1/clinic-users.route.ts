import { Router, type Request, type Response } from "express";
import { UserRole } from "@prisma/client";
import { z } from "zod";

import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import { prisma } from "../../infrastructure/database/prisma-client";
import { PERMISSIONS, hasPermission, sanitizePermissions } from "../../modules/auth/rbac";
import {
  createPasswordSetupLink,
  sendPasswordSetupEmail
} from "../../modules/clinics/onboarding-credentials.service";

const createUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional().or(z.literal("")),
  email: z.string().trim().email().max(254),
  permissions: z.array(z.string()).default([])
});

const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional().or(z.literal("")),
  permissions: z.array(z.string()).optional()
});

type TeamActor = {
  userId?: string;
  clinicId?: string;
  role: string;
  permissions: string[];
};

const actorFrom = (req: Request): TeamActor => ({
  userId: req.get("x-voone-user-id")?.trim(),
  role: req.get("x-voone-role")?.trim().toUpperCase() ?? "",
  clinicId: req.get("x-voone-clinic-id")?.trim(),
  permissions: (req.get("x-voone-permissions") ?? "")
    .split(",")
    .map((permission) => permission.trim())
    .filter(Boolean)
});

const canManageTeam = (actor: TeamActor, clinicId: string): boolean =>
  actor.clinicId === clinicId && hasPermission(actor, PERMISSIONS.teamManage);

const serializeUser = (user: {
  id: string;
  name: string | null;
  email: string;
  role: UserRole;
  permissions: string[];
  passwordHash?: string | null;
  onboardingPasswordGeneratedAt?: Date | null;
  onboardingCredentialsSentAt?: Date | null;
}) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  permissions: user.permissions,
  hasPassword: Boolean(user.passwordHash),
  onboardingPasswordGeneratedAt: user.onboardingPasswordGeneratedAt,
  onboardingCredentialsSentAt: user.onboardingCredentialsSentAt
});

const requireTeamManager = (req: Request, res: Response) => {
  const actor = actorFrom(req);

  if (!actor.role) {
    res.status(403).json({ code: "FORBIDDEN", message: "Missing staff session role" });
    return null;
  }

  if (!canManageTeam(actor, req.params.clinicId)) {
    res.status(403).json({ code: "FORBIDDEN", message: "Team management permission is required" });
    return null;
  }

  return actor;
};

export const clinicUsersRouter = Router();
const requireStaff = createRequireStaffKey(config.STAFF_API_KEY);

clinicUsersRouter.get(
  "/clinics/:clinicId/users",
  requireStaff,
  asyncHandler(async (req, res) => {
    if (!requireTeamManager(req, res)) return;

    const users = await prisma.user.findMany({
      where: { clinicId: req.params.clinicId },
      orderBy: { createdAt: "asc" }
    });

    res.json({ users: users.map(serializeUser) });
  })
);

clinicUsersRouter.post(
  "/clinics/:clinicId/users",
  requireStaff,
  asyncHandler(async (req, res) => {
    if (!requireTeamManager(req, res)) return;

    const parsed = createUserSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ code: "BAD_REQUEST", message: "Invalid user payload" });
      return;
    }

    const clinic = await prisma.clinic.findUnique({ where: { id: req.params.clinicId } });

    if (!clinic) {
      res.status(404).json({ code: "CLINIC_NOT_FOUND", message: "Clinic not found" });
      return;
    }

    const permissions = sanitizePermissions(parsed.data.permissions);

    try {
      const user = await prisma.user.create({
        data: {
          clinicId: clinic.id,
          name: parsed.data.name || null,
          email: parsed.data.email.toLowerCase(),
          role: UserRole.STAFF,
          permissions,
          onboardingPasswordGeneratedAt: new Date()
        }
      });
      const setupLink = await createPasswordSetupLink(prisma, user.id);
      let emailSent = false;
      let sentAt: Date | null = null;

      try {
        await sendPasswordSetupEmail({
          to: user.email,
          clinicName: clinic.name,
          setupUrl: setupLink.url
        });
        emailSent = true;
        sentAt = new Date();
      } catch (error) {
        console.error("[clinic-users] password setup email could not be sent:", error);
      }

      const updated = sentAt
        ? await prisma.user.update({
            where: { id: user.id },
            data: { onboardingCredentialsSentAt: sentAt }
          })
        : user;

      res.status(201).json({
        user: serializeUser(updated),
        setupUrl: setupLink.url,
        setupTokenExpiresAt: setupLink.expiresAt,
        emailSent
      });
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        res
          .status(409)
          .json({ code: "EMAIL_EXISTS", message: "A user with this email already exists" });
        return;
      }

      throw error;
    }
  })
);

clinicUsersRouter.put(
  "/clinics/:clinicId/users/:userId",
  requireStaff,
  asyncHandler(async (req, res) => {
    if (!requireTeamManager(req, res)) return;

    const parsed = updateUserSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ code: "BAD_REQUEST", message: "Invalid user payload" });
      return;
    }

    const user = await prisma.user.findFirst({
      where: { id: req.params.userId, clinicId: req.params.clinicId }
    });

    if (!user) {
      res.status(404).json({ code: "USER_NOT_FOUND", message: "User not found" });
      return;
    }

    if (user.role === UserRole.OWNER) {
      res
        .status(422)
        .json({ code: "OWNER_LOCKED", message: "Owner account permissions cannot be edited here" });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name || null } : {}),
        ...(parsed.data.permissions
          ? { permissions: sanitizePermissions(parsed.data.permissions) }
          : {})
      }
    });

    res.json({ user: serializeUser(updated) });
  })
);

clinicUsersRouter.delete(
  "/clinics/:clinicId/users/:userId",
  requireStaff,
  asyncHandler(async (req, res) => {
    const actor = requireTeamManager(req, res);
    if (!actor) return;

    const user = await prisma.user.findFirst({
      where: { id: req.params.userId, clinicId: req.params.clinicId }
    });

    if (!user) {
      res.status(404).json({ code: "USER_NOT_FOUND", message: "User not found" });
      return;
    }

    if (user.role === UserRole.OWNER || user.id === actor.userId) {
      res.status(422).json({ code: "USER_LOCKED", message: "This account cannot be deleted here" });
      return;
    }

    await prisma.user.delete({ where: { id: user.id } });

    res.status(204).send();
  })
);
