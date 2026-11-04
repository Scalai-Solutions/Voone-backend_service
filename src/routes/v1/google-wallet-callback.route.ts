import { WalletProviderType, type PrismaClient } from "@prisma/client";
import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler";
import {
  verifyGoogleCallback,
  type GoogleRootKey
} from "../../wallet/providers/google/callback-verifier";

/**
 * Google Wallet's save/delete callback (the class's callbackOptions.url).
 *
 * Deliberately NOT behind the staff key or the edge guard: the caller is Google. Its credential is
 * the ECv2SigningOnly signature, checked before anything is read or written.
 *
 * On a save, the member's card is synced (so the tier benefits are on the pass the moment it lands
 * on the phone) and the welcome to their tier goes out. Both are idempotent, which is how Google's
 * duplicate deliveries (same nonce) and retries are absorbed without storing nonces.
 *
 * Status codes: 400 for anything that is not a verified callback; 200 once handled, including for
 * an object we do not know or a deletion, so Google does not retry those; a 5xx from a failure
 * here, so it does retry.
 */
export interface GoogleWalletCallbackDeps {
  prisma: Pick<PrismaClient, "walletObject">;
  rootKeys: () => Promise<GoogleRootKey[]>;
  issuerId: () => string;
  enqueueMemberSync: (memberId: string) => Promise<void>;
  welcome: (memberId: string) => Promise<unknown>;
}

export const createGoogleWalletCallbackRouter = (deps: GoogleWalletCallbackDeps): Router => {
  const router = Router();

  router.post(
    "/google-wallet/callback",
    asyncHandler(async (req, res) => {
      const message = verifyGoogleCallback(req.body, await deps.rootKeys(), deps.issuerId());

      if (!message) {
        res.sendStatus(400);
        return;
      }

      if (message.eventType !== "save") {
        res.sendStatus(200);
        return;
      }

      const walletObject = await deps.prisma.walletObject.findFirst({
        where: { provider: WalletProviderType.GOOGLE, externalObjectId: message.objectId },
        select: { memberId: true }
      });

      if (walletObject) {
        await deps.enqueueMemberSync(walletObject.memberId);
        await deps.welcome(walletObject.memberId);
      }

      res.sendStatus(200);
    })
  );

  return router;
};
