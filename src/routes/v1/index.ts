import { Router } from "express";

import { prisma } from "../../infrastructure/database/prisma-client";
import { config } from "../../config/env";
import { PrismaLoyaltyCardAssembler } from "../../wallet/prisma-loyalty-card.assembler";
import { PrismaPassDeviceRepository } from "../../wallet/prisma-pass-device.repository";
import { PrismaWalletSyncRepository } from "../../wallet/prisma-wallet-sync.repository";
import {
  PrismaMemberPointsCache,
  PrismaPointsLedgerRepository
} from "../../modules/points/prisma-points-ledger.repository";
import { PointsService } from "../../modules/points/points.service";
import { buildWalletSyncQueue } from "../../wallet/wallet.composition";
import { createPointsRouter } from "./points.route";
import { createAppleRefreshChannel } from "../../wallet/providers/apple/apple-refresh-channel.factory";
import { createAppleWalletProvider } from "../../wallet/providers/apple/apple-wallet.provider";
import { adminClinicsRouter } from "./admin-clinics.route";
import { createApplePassesRouter } from "./apple-passes.route";
import { clinicsRouter } from "./clinics.route";
import { healthRouter } from "./health.route";
import { membersRouter } from "./members.route";
import { templatesRouter } from "./templates.route";
import { walletTestRouter } from "./wallet-test.route";

export const v1Router = Router();

v1Router.use(healthRouter);
v1Router.use(adminClinicsRouter);
v1Router.use(clinicsRouter);
v1Router.use(membersRouter);
v1Router.use(templatesRouter);

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

if (walletSyncQueue) {
  v1Router.use(
    createPointsRouter({
      points: new PointsService(
        new PrismaPointsLedgerRepository(prisma),
        new PrismaMemberPointsCache(prisma),
        walletSyncQueue
      ),
      // Resolved from the member rather than trusted from the body: a staff caller must
      // not be able to attribute a movement to a clinic that is not the member's.
      clinicOfMember: async (memberId) => {
        const member = await prisma.member.findUnique({
          where: { id: memberId },
          select: { clinicId: true, erasedAt: true }
        });

        return member && !member.erasedAt ? member.clinicId : null;
      }
    })
  );
}

if (process.env.NODE_ENV !== "production") {
  v1Router.use(walletTestRouter);
}
