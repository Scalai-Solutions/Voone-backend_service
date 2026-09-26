import { WalletProviderType } from "@prisma/client";
import { Router } from "express";

import { MemberNotFoundError } from "../../common/errors/membership.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import type { CardIssuer } from "../../modules/wallet/card-issuer";

export interface MemberPassRouterDeps {
  issuer: CardIssuer;
  /** The member a claim token is good for, or null if it is unknown or expired. */
  memberForClaim: (token: string) => Promise<string | null>;
  /** Refuses a member who does not exist or has been erased, before anything is issued. */
  memberExists: (memberId: string) => Promise<boolean>;
}

/**
 * Hands a member's card to staff.
 *
 * Staff-only, and that is what makes it safe to exist before the member-facing delivery
 * flow does. VOO-102 settled that members receive a link by SMS precisely so that
 * submitting someone else's phone number cannot hand over their card; this route does not
 * weaken that, because reaching it requires the staff key, which is held server-side by
 * the dashboard and never reaches a browser.
 *
 * It is also the path a clinic needs anyway: a member at reception whose phone has died
 * asks for their card again, and the answer should not be "we will text you".
 */
export const createMemberPassRouter = (deps: MemberPassRouterDeps): Router => {
  const router = Router();
  const requireStaff = createRequireStaffKey(config.STAFF_API_KEY);

  router.get(
    "/members/:memberId/pass/apple",
    requireStaff,
    asyncHandler(async (req, res) => {
      if (!(await deps.memberExists(req.params.memberId))) {
        throw new MemberNotFoundError(req.params.memberId);
      }

      const artifact = await deps.issuer.artifactFor(req.params.memberId, WalletProviderType.APPLE);

      // Apple's artifact is always a file; the union is checked rather than asserted so
      // that a provider changing its mind fails here instead of sending a link as bytes.
      if (artifact.kind !== "file") {
        res.status(200).json({ kind: artifact.kind, url: artifact.url });

        return;
      }

      res
        .status(200)
        .type(artifact.contentType)
        // Without this the browser renders the bytes instead of handing them to Wallet.
        .set("Content-Disposition", `attachment; filename="${artifact.fileName}"`)
        // A pass is personal and short-lived in the way a cache would get wrong: the
        // points inside it change.
        .set("Cache-Control", "no-store")
        .send(artifact.buffer);
    })
  );

  /**
   * PUBLIC. The member's own browser exchanges the claim it was handed at sign-up.
   *
   * No staff key, because the caller is the member on their phone — which is the point:
   * they scanned a QR, filled in a form, and the card should appear. Authorisation is
   * the token itself, which is 32 random bytes, stored only as a SHA-256 hash, valid
   * for fifteen minutes, and issued only to a browser that just created the member.
   *
   * Under /pass-claims rather than /passes on purpose: /passes/:passTypeIdentifier/
   * :serialNumber is Apple's device web service and has the same segment count, so a
   * claim would be ambiguous with a pass fetch depending on mount order.
   */
  router.get(
    "/pass-claims/:token",
    asyncHandler(async (req, res) => {
      const memberId = await deps.memberForClaim(req.params.token);

      // Unknown, expired and belonging-to-nobody are one answer. Distinguishing them
      // would turn this into an oracle for which tokens ever existed.
      if (!memberId) {
        res.status(404).json({ code: "CLAIM_NOT_FOUND", message: "Not found" });

        return;
      }

      const artifact = await deps.issuer.artifactFor(memberId, WalletProviderType.APPLE);

      if (artifact.kind !== "file") {
        res.status(200).json({ kind: artifact.kind, url: artifact.url });

        return;
      }

      res
        .status(200)
        .type(artifact.contentType)
        .set("Content-Disposition", `attachment; filename="${artifact.fileName}"`)
        // Never cached: the bytes are personal, and a shared cache holding one member's
        // pass is the worst version of this endpoint going wrong.
        .set("Cache-Control", "no-store, private")
        .send(artifact.buffer);
    })
  );

  return router;
};
