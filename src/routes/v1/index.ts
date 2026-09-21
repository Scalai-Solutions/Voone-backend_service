import { Router } from "express";

import { prisma } from "../../infrastructure/database/prisma-client";
import { config } from "../../config/env";
import { NoopRefreshChannel } from "../../wallet/engine/pass-refresh-channel.interface";
import { PrismaLoyaltyCardAssembler } from "../../wallet/prisma-loyalty-card.assembler";
import { PrismaPassDeviceRepository } from "../../wallet/prisma-pass-device.repository";
import { PrismaWalletSyncRepository } from "../../wallet/prisma-wallet-sync.repository";
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
v1Router.use(clinicsRouter);
v1Router.use(adminClinicsRouter);
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
        new NoopRefreshChannel(),
        devices,
        config.APPLE_PASS_WEB_SERVICE_URL
      ),
      devices,
      assembler: new PrismaLoyaltyCardAssembler(prisma, config.CARD_REDEMPTION_SECRET)
    })
  );
}

if (process.env.NODE_ENV !== "production") {
  v1Router.use(walletTestRouter);
}
