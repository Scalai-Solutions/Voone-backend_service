import { OnboardingProgramStatus } from "@prisma/client";
import { Router } from "express";

import { prisma } from "../../infrastructure/database/prisma-client";
import { WalletConfigurationError } from "../../common/errors/wallet.errors";
import { config } from "../../config/env";
import { PrismaLoyaltyCardAssembler } from "../../wallet/prisma-loyalty-card.assembler";
import { PrismaPassDeviceRepository } from "../../wallet/prisma-pass-device.repository";
import { recordAppleDownload } from "../../wallet/apple-updates-registered";
import { PrismaWalletSyncRepository } from "../../wallet/prisma-wallet-sync.repository";
import {
  PrismaMemberPointsCache,
  PrismaPointsLedgerRepository
} from "../../modules/points/prisma-points-ledger.repository";
import { PointsService } from "../../modules/points/points.service";
import { buildNotificationService } from "../../modules/notifications/notification.composition";
import { buildWalletSyncQueue } from "../../wallet/wallet.composition";
import { buildImageStorage } from "../../modules/media/image-storage";
import { createBonosRouter } from "./bonos.route";
import { createPointsRouter } from "./points.route";
import { createImagesRouter } from "./images.route";
import { createOnboardingRouter } from "./onboarding.route";
import { createTreatmentsRouter } from "./treatments.route";
import {
  createTreatmentCatalogue,
  scanScreenTreatments
} from "../../modules/treatments/treatment-catalogue.service";
import { findClinicBySlug } from "../../modules/clinics/clinic.service";
import {
  createPlan,
  listPlans,
  removePlan,
  updatePlan
} from "../../modules/bonos/bono-plan.service";
import { cancelMemberBono, listForMember } from "../../modules/bonos/member-bono.service";
import { PrismaCatalogRepository } from "../../modules/onboarding/catalog.repository";
import { OnboardingService } from "../../modules/onboarding/onboarding.service";
import {
  PrismaProgramTierPort,
  hasActiveProgram
} from "../../modules/onboarding/runtime/program-tier.port";
import { RewardService } from "../../modules/onboarding/runtime/reward.service";
import { VisitService } from "../../modules/onboarding/runtime/visit.service";
import { CardIssuer } from "../../modules/wallet/card-issuer";
import { buildWalletRegistry } from "../../wallet/wallet.composition";
import { createMemberPassRouter } from "./member-pass.route";
import { PrismaPassClaimService } from "../../modules/members/pass-claim.service";
import { MemberDirectoryService } from "../../modules/members/member-directory.service";
import { createMemberDirectoryRouter } from "./member-directory.route";
import { certificateStatus, isAppleWalletConfigured } from "../../config/apple-wallet.config";
import { DashboardService } from "../../modules/dashboard/dashboard.service";
import { createDashboardRouter } from "./dashboard.route";
import { createAppleRefreshChannel } from "../../wallet/providers/apple/apple-refresh-channel.factory";
import { createAppleWalletProvider } from "../../wallet/providers/apple/apple-wallet.provider";
import { adminClinicsRouter } from "./admin-clinics.route";
import { createApplePassesRouter } from "./apple-passes.route";
import { clinicUsersRouter } from "./clinic-users.route";
import { clinicsRouter } from "./clinics.route";
import { healthRouter } from "./health.route";
import { membersRouter } from "./members.route";
import { createNotificationsRouter } from "./notifications.route";
import { templatesRouter } from "./templates.route";
import { walletTestRouter } from "./wallet-test.route";

export const v1Router = Router();
const notificationService = buildNotificationService(prisma);

v1Router.use(healthRouter);
v1Router.use(adminClinicsRouter);
v1Router.use(clinicUsersRouter);
v1Router.use(clinicsRouter);
v1Router.use(membersRouter);
v1Router.use(templatesRouter);
v1Router.use(createNotificationsRouter({ notifications: notificationService }));

/**
 * Logo and hero uploads. Always mounted: with no Bunny configuration the routes answer 503
 * with a message saying so, which is more useful to the dashboard than a 404.
 */
v1Router.use(
  createImagesRouter({
    staffKey: config.STAFF_API_KEY,
    storage: buildImageStorage(config),
    findClinic: (slug) => findClinicBySlug(prisma, slug)
  })
);

/**
 * Apple's pass web service.
 *
 * Mounted only when there is signing material and a redemption secret: without a
 * certificate no pass exists to update, and routes that would 500 on every call are worse
 * than routes that 404. This is the same "ships dark" rule the provider registry applies,
 * one layer up — the day the certificate arrives, these appear with a restart.
 */
if (config.APPLE_PASS_WEB_SERVICE_URL && config.CARD_REDEMPTION_SECRET) {
  const devices = new PrismaPassDeviceRepository(prisma);

  v1Router.use(
    createApplePassesRouter({
      provider: createAppleWalletProvider(
        new PrismaWalletSyncRepository(prisma),
        createAppleRefreshChannel(devices),
        devices,
        config.APPLE_PASS_WEB_SERVICE_URL
      ),
      devices,
      assembler: new PrismaLoyaltyCardAssembler(prisma, config.CARD_REDEMPTION_SECRET)
    })
  );
}

/**
 * Points movements, mounted only when the wallet subsystem is configured.
 *
 * Not because crediting needs a wallet — the ledger stands alone — but because every
 * credit enqueues a sync, and a queue that cannot be built would make each movement
 * throw after it had already been recorded. Better absent than half-working.
 */
const walletSyncQueue = buildWalletSyncQueue(prisma);

/**
 * The points service every route here shares, built once.
 *
 * It carries the programme port, so a clinic that has published an onboarding programme gets
 * tenure-aware tiers and exact milestone notifications, and every other clinic gets the legacy
 * rules unchanged.
 */
const pointsService = walletSyncQueue
  ? new PointsService(
      new PrismaPointsLedgerRepository(prisma),
      new PrismaMemberPointsCache(prisma),
      walletSyncQueue,
      notificationService,
      new PrismaProgramTierPort(prisma)
    )
  : null;

if (pointsService) {
  v1Router.use(
    createPointsRouter({
      points: pointsService,
      // Resolved from the member rather than trusted from the body: a staff caller must
      // not be able to attribute a movement to a clinic that is not the member's.
      clinicOfMember: async (memberId) => {
        const member = await prisma.member.findUnique({
          where: { id: memberId },
          select: { clinicId: true, erasedAt: true }
        });

        return member && !member.erasedAt ? member.clinicId : null;
      },
      // At a clinic on a programme, points come from recorded visits, not from typing.
      usesProgram: (clinicId) => hasActiveProgram(prisma, clinicId)
    })
  );
}

/**
 * Onboarding and the programme's runtime.
 *
 * The catalogue and programme routes need only the database. Recording a visit and redeeming
 * a reward credit points, so those are wired only when the points service could be built —
 * and report 503 rather than disappearing, so a deployment missing its wallet configuration
 * says why instead of answering 404.
 */
const catalogRepository = new PrismaCatalogRepository(prisma);

v1Router.use(
  createOnboardingRouter({
    onboarding: new OnboardingService(prisma, catalogRepository),
    catalog: catalogRepository,
    visits: pointsService ? new VisitService(prisma, pointsService) : undefined,
    rewards: new RewardService(prisma, undefined, pointsService ?? undefined),
    findClinic: (slug) => findClinicBySlug(prisma, slug),
    clinicExists: async (clinicId) => (await prisma.clinic.count({ where: { id: clinicId } })) > 0
  })
);

v1Router.use(
  createTreatmentsRouter({
    catalogue: createTreatmentCatalogue(prisma),
    findClinic: (slug) => findClinicBySlug(prisma, slug)
  })
);

/**
 * Bono de sesiones: the plans the owner defines, and the bonos members hold. The same two
 * audiences as the onboarding router — admin by clinic id while setting a centre up, the
 * centre's own staff by slug afterwards.
 */
v1Router.use(
  createBonosRouter({
    plans: {
      list: (clinicId) => listPlans(prisma, clinicId),
      create: (clinicId, input) => createPlan(prisma, clinicId, input),
      update: (clinicId, id, patch) => updatePlan(prisma, clinicId, id, patch),
      remove: (clinicId, id) => removePlan(prisma, clinicId, id)
    },
    memberBonos: {
      listForMember: (clinicId, memberId) => listForMember(prisma, clinicId, memberId),
      cancel: (clinicId, memberId, bonoId) => cancelMemberBono(prisma, clinicId, memberId, bonoId)
    },
    findClinic: (slug) => findClinicBySlug(prisma, slug),
    clinicExists: async (clinicId) => (await prisma.clinic.count({ where: { id: clinicId } })) > 0
  })
);

/**
 * Staff card download. Needs the same two variables as the Apple routes, because without
 * a redemption secret no card can be assembled and without signing material none can be
 * built.
 */
if (config.CARD_REDEMPTION_SECRET) {
  const cards = new PrismaWalletSyncRepository(prisma);

  v1Router.use(
    createMemberPassRouter({
      issuer: new CardIssuer(
        buildWalletRegistry(prisma),
        cards,
        new PrismaLoyaltyCardAssembler(prisma, config.CARD_REDEMPTION_SECRET),
        async (memberId) => {
          const member = await prisma.member.findUnique({
            where: { id: memberId },
            select: {
              clinic: {
                select: {
                  name: true,
                  template: true,
                  // Whether the live programme owns the benefits the class shows.
                  onboardingPrograms: {
                    where: { status: OnboardingProgramStatus.ACTIVO },
                    take: 1,
                    select: { id: true }
                  }
                }
              }
            }
          });

          const template = member?.clinic.template;

          if (!template) {
            throw new WalletConfigurationError(
              `Member ${memberId} has no clinic template, so no programme can be provisioned.`
            );
          }

          return {
            templateId: template.id,
            clinicName: member.clinic.name,
            tierBenefitsFromProgramme: member.clinic.onboardingPrograms.length > 0,
            template: {
              programName: template.programName,
              backgroundColor: template.hexBackgroundColor,
              logoUrl: template.logoUrl ?? undefined,
              heroImageUrl: template.heroImageUrl ?? undefined,
              pointsLabel: template.pointsLabel,
              tierLabel: template.tierLabel,
              benefitsText: template.benefitsText || undefined,
              infoText: template.infoText || undefined
            }
          };
        }
      ),
      memberForClaim: (token) => new PrismaPassClaimService(prisma).resolve(token),
      memberExists: async (memberId) => {
        const member = await prisma.member.findUnique({
          where: { id: memberId },
          select: { erasedAt: true }
        });

        return Boolean(member && !member.erasedAt);
      },
      recordAppleDownload: (memberId) =>
        recordAppleDownload(new PrismaPassDeviceRepository(prisma), memberId)
    })
  );
}

/**
 * The clinic dashboard's reads. Unconditional: these are plain database queries and do
 * not need a wallet, a certificate or a redemption secret, so hiding them behind wallet
 * configuration would make the members page depend on something unrelated.
 */
v1Router.use(
  createMemberDirectoryRouter({
    directory: new MemberDirectoryService(prisma, () => {
      // Asked per request rather than captured once: the registry reflects what is
      // configured at boot, and reporting a provider as available when it is not would
      // have staff chasing members to add a card that cannot exist.
      const registry = buildWalletRegistry(prisma);

      return new Set(registry.enabled().map((provider) => provider.provider));
    }),
    revokeMemberCard: async (ref) => {
      const provider = buildWalletRegistry(prisma).get(ref.provider);

      if (!provider) return false;

      await provider.revokeCard(ref);

      return true;
    },
    syncMemberCard: (memberId) => {
      // Best effort: an edit must not fail because the wallet queue is not configured.
      // The next pass issue or sync picks the change up either way.
      void walletSyncQueue?.enqueueMemberSync(memberId);
    },
    clinicIdForSlug: async (slug) => {
      const clinic = await prisma.clinic.findFirst({
        where: { slug, isActive: true },
        select: { id: true }
      });

      return clinic?.id ?? null;
    },
    treatmentsFor: (clinicId) => scanScreenTreatments(prisma, clinicId)
  })
);

v1Router.use(
  createDashboardRouter({
    dashboard: new DashboardService(
      prisma,
      () => {
        // Reads the certificate rather than a configured date, so the panel cannot
        // disagree with the material that actually signs the passes. Unconfigured is a
        // real state and is reported as such instead of throwing.
        if (!isAppleWalletConfigured()) return { expiresAt: null, enabled: false };

        try {
          return { expiresAt: certificateStatus().validTo, enabled: true };
        } catch {
          // Present but unusable — a wrong passphrase, a mismatched key. Enabled is
          // false because no pass can be signed, which is what the panel is asking.
          return { expiresAt: null, enabled: false };
        }
      },
      () => config.GOOGLE_WALLET_PUBLISHING_STATUS
    )
  })
);

if (process.env.NODE_ENV !== "production") {
  v1Router.use(walletTestRouter);
}
