import { Router } from "express";
import { WalletProviderType, WalletSyncStatus } from "@prisma/client";
import { z } from "zod";

import { MembershipValidationError } from "../../common/errors/membership.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import { prisma } from "../../infrastructure/database/prisma-client";
import { provisionClinicSchema } from "../../modules/clinics/clinic-provisioning.schema";
import {
  createPasswordSetupLink,
  hashPassword,
  passwordSetupUrl,
  sendPasswordSetupEmail,
  verifyPassword
} from "../../modules/clinics/onboarding-credentials.service";
import {
  provisionClinic,
  toProvisionedSummary
} from "../../modules/clinics/clinic-provisioning.service";

export const adminClinicsRouter = Router();

const emptyWalletStatus = {
  google: "not_added",
  apple: "not_added"
} as const;

const walletProviderKey = (provider: WalletProviderType): keyof typeof emptyWalletStatus =>
  provider === WalletProviderType.GOOGLE ? "google" : "apple";

const providerStatus = (status: WalletSyncStatus) =>
  status === WalletSyncStatus.SYNCED
    ? "added"
    : status === WalletSyncStatus.FAILED
      ? "failed"
      : "not_added";

const toWalletStatus = (
  walletClasses: Array<{ provider: WalletProviderType; status: WalletSyncStatus }>
) =>
  walletClasses.reduce(
    (statuses, walletClass) => ({
      ...statuses,
      [walletProviderKey(walletClass.provider)]: providerStatus(walletClass.status)
    }),
    emptyWalletStatus
  );

const planQuota = (plan: string): number => {
  if (plan === "pro") return 30;
  if (plan === "medium") return 15;
  return 8;
};

const passwordSetupSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters").max(128),
    confirmPassword: z.string().min(1, "Confirm your password")
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match"
  });

type AdminClinicSummaryUser = {
  id: string;
  email: string;
  role: string;
  passwordHash?: string | null;
  onboardingPasswordGeneratedAt?: Date | null;
  onboardingCredentialsSentAt?: Date | null;
  passwordSetupTokens?: Array<{ id: string; expiresAt: Date }>;
};

type AdminClinicSummaryInput = Omit<
  Awaited<ReturnType<typeof listAdminClinics>>[number],
  "users"
> & {
  users: AdminClinicSummaryUser[];
};

const toAdminClinicSummary = (clinic: AdminClinicSummaryInput) => ({
  id: clinic.id,
  slug: clinic.slug,
  name: clinic.name,
  addressLine: clinic.addressLine,
  pincode: clinic.pincode,
  isActive: clinic.isActive,
  privacyPolicyVersion: clinic.privacyPolicyVersion,
  voonePlan: clinic.voonePlan,
  notificationsMonthlyQuota: clinic.notificationsMonthlyQuota,
  notificationsUsedThisMonth: clinic.notificationsUsedThisMonth,
  notificationsRemainingThisMonth: Math.max(
    0,
    clinic.notificationsMonthlyQuota - clinic.notificationsUsedThisMonth
  ),
  status: clinic.isActive && clinic.template ? "active" : "setup",
  members: clinic._count.members,
  templates: clinic.template ? 1 : 0,
  treatments: clinic.treatments.map((treatment) => ({
    id: treatment.id,
    name: treatment.name,
    priceEuro: treatment.priceEuro,
    points: treatment.pointsAllotted
  })),
  users: clinic.users.map((user) => ({ id: user.id, email: user.email, role: user.role })),
  onboardingCredentials: (() => {
    const owner = clinic.users.find((user) => user.role === "OWNER") ?? clinic.users[0];
    const setupToken = owner?.passwordSetupTokens?.[0];

    return owner
      ? {
          email: owner.email,
          setupUrl: setupToken ? passwordSetupUrl(setupToken.id) : null,
          setupTokenExpiresAt: setupToken?.expiresAt ?? null,
          generatedAt: owner.onboardingPasswordGeneratedAt,
          sentAt: owner.onboardingCredentialsSentAt,
          hasPassword: Boolean(owner.passwordHash)
        }
      : null;
  })(),
  template: clinic.template
    ? {
        id: clinic.template.id,
        programName: clinic.template.programName,
        presetId: clinic.template.presetId,
        hexBackgroundColor: clinic.template.hexBackgroundColor,
        logoUrl: clinic.template.logoUrl,
        heroImageUrl: clinic.template.heroImageUrl,
        websiteUrl: clinic.template.websiteUrl,
        appointmentUrl: clinic.template.appointmentUrl,
        appLinkText: clinic.template.appLinkText,
        appLinkDescription: clinic.template.appLinkDescription,
        pointsLabel: clinic.template.pointsLabel,
        tierLabel: clinic.template.tierLabel,
        benefitsText: clinic.template.benefitsText,
        infoText: clinic.template.infoText,
        tierRewards: clinic.template.tierRewards,
        milestoneRewards: clinic.template.milestoneRewards,
        status: clinic.template.status,
        walletStatus: toWalletStatus(clinic.template.walletClasses)
      }
    : null
});

const toAdminMemberSummary = (member: Awaited<ReturnType<typeof listAdminMembers>>[number]) => ({
  id: member.id,
  name: member.name,
  identity: member.phone ?? member.email ?? member.id,
  templateId: member.clinic.template?.id ?? "",
  templateName: member.clinic.template?.programName ?? member.clinic.name,
  points: member.pointsBalance,
  tier: member.tier ?? "Nuevo",
  walletStatus: member.walletObjects.reduce(
    (statuses, walletObject) => ({
      ...statuses,
      [walletProviderKey(walletObject.provider)]:
        walletObject.status === WalletSyncStatus.SYNCED ? "added" : "failed"
    }),
    emptyWalletStatus
  ),
  history: []
});

const listAdminClinics = () =>
  prisma.clinic.findMany({
    include: {
      users: {
        orderBy: { createdAt: "asc" },
        include: {
          passwordSetupTokens: {
            where: { usedAt: null, expiresAt: { gt: new Date() } },
            orderBy: { createdAt: "desc" },
            take: 1
          }
        }
      },
      treatments: { orderBy: { createdAt: "asc" } },
      template: { include: { walletClasses: true } },
      _count: { select: { members: true } }
    },
    orderBy: { createdAt: "desc" }
  });

const listAdminClinicsWithoutSetupTokens = () =>
  prisma.clinic.findMany({
    include: {
      users: { orderBy: { createdAt: "asc" } },
      treatments: { orderBy: { createdAt: "asc" } },
      template: { include: { walletClasses: true } },
      _count: { select: { members: true } }
    },
    orderBy: { createdAt: "desc" }
  });

const listAdminClinicsSafe = async () => {
  try {
    return await listAdminClinics();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2021"
    ) {
      console.warn(
        "[admin] PasswordSetupToken table is missing; returning clinic details without setup links. Run the password setup migration."
      );

      return listAdminClinicsWithoutSetupTokens();
    }

    throw error;
  }
};

const listAdminMembers = () =>
  prisma.member.findMany({
    where: { erasedAt: null },
    include: {
      clinic: { include: { template: true } },
      walletObjects: true
    },
    orderBy: { createdAt: "desc" }
  });

adminClinicsRouter.get(
  "/admin/clinics",
  createRequireStaffKey(config.STAFF_API_KEY),
  asyncHandler(async (_req, res) => {
    const clinics = await listAdminClinicsSafe();

    res.json(clinics.map(toAdminClinicSummary));
  })
);

adminClinicsRouter.post(
  "/auth/credentials",
  createRequireStaffKey(config.STAFF_API_KEY),
  asyncHandler(async (req, res) => {
    const identifier =
      typeof req.body?.identifier === "string" ? req.body.identifier.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!identifier || !password) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { email: identifier },
      include: { clinic: true }
    });

    if (!user || !verifyPassword(password, user.passwordHash)) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    res.json({
      id: user.id,
      name: user.name ?? user.email,
      email: user.email,
      role: user.role.toLowerCase(),
      clinicId: user.clinicId ?? "",
      clinicSlug: user.clinic?.slug ?? ""
    });
  })
);

adminClinicsRouter.post(
  "/admin/clinics/:clinicId/credentials/share",
  createRequireStaffKey(config.STAFF_API_KEY),
  asyncHandler(async (req, res) => {
    const clinic = await prisma.clinic.findUnique({
      where: { id: req.params.clinicId },
      include: { users: { orderBy: { createdAt: "asc" } } }
    });

    if (!clinic) {
      res.status(404).json({ message: "Clinic not found" });
      return;
    }

    const owner = clinic.users.find((user) => user.role === "OWNER") ?? clinic.users[0];

    if (!owner) {
      res.status(422).json({ message: "Clinic has no owner email to share credentials with" });
      return;
    }

    const setupLink = await createPasswordSetupLink(prisma, owner.id);
    let sentAt: Date | null = null;
    let emailSent = false;

    try {
      await sendPasswordSetupEmail({
        to: owner.email,
        clinicName: clinic.name,
        setupUrl: setupLink.url
      });
      sentAt = new Date();
      emailSent = true;
    } catch (error) {
      console.error("[admin] password setup email could not be sent:", error);
    }

    const updated = await prisma.user.update({
      where: { id: owner.id },
      data: {
        onboardingPasswordGeneratedAt: new Date(),
        ...(sentAt ? { onboardingCredentialsSentAt: sentAt } : {})
      }
    });

    res.json({
      email: updated.email,
      setupUrl: setupLink.url,
      setupTokenExpiresAt: setupLink.expiresAt,
      generatedAt: updated.onboardingPasswordGeneratedAt,
      sentAt: updated.onboardingCredentialsSentAt,
      hasPassword: Boolean(updated.passwordHash),
      emailSent
    });
  })
);

adminClinicsRouter.get(
  "/auth/password-setup/:token",
  asyncHandler(async (req, res) => {
    const setupToken = await prisma.passwordSetupToken.findFirst({
      where: { id: req.params.token, usedAt: null, expiresAt: { gt: new Date() } },
      include: { user: { include: { clinic: true } } }
    });

    if (!setupToken) {
      res.status(404).json({
        code: "PASSWORD_SETUP_LINK_INVALID",
        message: "Password setup link is invalid or expired"
      });
      return;
    }

    res.json({
      email: setupToken.user.email,
      clinicName: setupToken.user.clinic?.name ?? "Voone",
      expiresAt: setupToken.expiresAt,
      hasPassword: Boolean(setupToken.user.passwordHash)
    });
  })
);

adminClinicsRouter.post(
  "/auth/password-setup/:token",
  asyncHandler(async (req, res) => {
    const parsed = passwordSetupSchema.safeParse(req.body);

    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");

      throw new MembershipValidationError(details);
    }

    const setupToken = await prisma.passwordSetupToken.findFirst({
      where: { id: req.params.token, usedAt: null, expiresAt: { gt: new Date() } }
    });

    if (!setupToken) {
      res.status(404).json({
        code: "PASSWORD_SETUP_LINK_INVALID",
        message: "Password setup link is invalid or expired"
      });
      return;
    }

    const now = new Date();

    await prisma.$transaction([
      prisma.user.update({
        where: { id: setupToken.userId },
        data: { passwordHash: hashPassword(parsed.data.password) }
      }),
      prisma.passwordSetupToken.update({
        where: { id: setupToken.id },
        data: { usedAt: now }
      }),
      prisma.passwordSetupToken.updateMany({
        where: { userId: setupToken.userId, usedAt: null },
        data: { usedAt: now }
      })
    ]);

    res.json({ status: "ok" });
  })
);

adminClinicsRouter.patch(
  "/admin/clinics/:clinicId",
  createRequireStaffKey(config.STAFF_API_KEY),
  asyncHandler(async (req, res) => {
    const clinic = await prisma.clinic.findUnique({ where: { id: req.params.clinicId } });

    if (!clinic) {
      res.status(404).json({ message: "Clinic not found" });
      return;
    }

    const voonePlan = typeof req.body?.voonePlan === "string" ? req.body.voonePlan : undefined;
    const isActive = typeof req.body?.isActive === "boolean" ? req.body.isActive : undefined;
    const notificationsMonthlyQuota = voonePlan ? planQuota(voonePlan) : undefined;

    await prisma.clinic.update({
      where: { id: clinic.id },
      data: {
        ...(isActive !== undefined ? { isActive } : {}),
        ...(voonePlan ? { voonePlan, notificationsMonthlyQuota } : {})
      }
    });

    const clinics = await listAdminClinicsSafe();
    const updated = clinics.find((item) => item.id === clinic.id);

    res.json(updated ? toAdminClinicSummary(updated) : { status: "ok" });
  })
);

adminClinicsRouter.delete(
  "/admin/clinics/:clinicId",
  createRequireStaffKey(config.STAFF_API_KEY),
  asyncHandler(async (req, res) => {
    const clinic = await prisma.clinic.findUnique({ where: { id: req.params.clinicId } });

    if (!clinic) {
      res.status(404).json({ message: "Clinic not found" });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.walletObject.deleteMany({ where: { member: { clinicId: clinic.id } } });
      await tx.member.deleteMany({ where: { clinicId: clinic.id } });
      await tx.walletClass.deleteMany({ where: { clinicTemplate: { clinicId: clinic.id } } });
      await tx.clinicTemplate.deleteMany({ where: { clinicId: clinic.id } });
      await tx.clinicTreatment.deleteMany({ where: { clinicId: clinic.id } });
      await tx.user.deleteMany({ where: { clinicId: clinic.id } });
      await tx.clinic.delete({ where: { id: clinic.id } });
    });

    res.status(204).send();
  })
);

adminClinicsRouter.get(
  "/admin/clinics/:clinicId",
  createRequireStaffKey(config.STAFF_API_KEY),
  asyncHandler(async (req, res) => {
    const clinics = await listAdminClinicsSafe();
    const clinic = clinics.find((item) => item.id === req.params.clinicId);

    if (!clinic) {
      res.status(404).json({ message: "Clinic not found" });
      return;
    }

    res.json(toAdminClinicSummary(clinic));
  })
);

adminClinicsRouter.get(
  "/admin/members",
  createRequireStaffKey(config.STAFF_API_KEY),
  asyncHandler(async (_req, res) => {
    const members = await listAdminMembers();

    res.json(members.map(toAdminMemberSummary));
  })
);

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
    const summary = toProvisionedSummary(provisioned);

    if (parsed.data.ownerEmail) {
      const owner = await prisma.user.findUnique({ where: { email: parsed.data.ownerEmail } });

      if (owner) {
        const setupLink = await createPasswordSetupLink(prisma, owner.id);
        await prisma.user.update({
          where: { id: owner.id },
          data: { onboardingPasswordGeneratedAt: new Date() }
        });

        res.status(201).json({
          ...summary,
          onboardingCredentials: {
            email: owner.email,
            setupUrl: setupLink.url,
            setupTokenExpiresAt: setupLink.expiresAt,
            hasPassword: Boolean(owner.passwordHash)
          }
        });
        return;
      }
    }

    res.status(201).json(summary);
  })
);
