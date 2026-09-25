import { WalletProviderType } from "@prisma/client";
import { Router } from "express";

import { MemberNotFoundError } from "../../common/errors/membership.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import type { CardIssuer } from "../../modules/wallet/card-issuer";

export interface MemberPassRouterDeps {
  issuer: CardIssuer;
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

  return router;
};
