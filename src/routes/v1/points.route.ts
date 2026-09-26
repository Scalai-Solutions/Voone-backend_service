import { Router, type Request, type Response } from "express";
import type { ZodType } from "zod";

import { MemberNotFoundError } from "../../common/errors/membership.errors";
import { PointsValidationError } from "../../common/errors/points.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import { clawBackSchema, creditSchema, redeemSchema } from "../../modules/points/points.schema";
import type { PointsService } from "../../modules/points/points.service";

export interface PointsRouterDeps {
  points: PointsService;
  /** Resolves the member's clinic, and refuses a member who does not exist or is erased. */
  clinicOfMember: (memberId: string) => Promise<string | null>;
}

/**
 * Staff-only points movements.
 *
 * Every route here is behind the staff key. A member must never be able to credit
 * themselves, and the key is held server-side by the dashboard's own route handler — it
 * never reaches a browser.
 *
 * Mounted only when the wallet subsystem is configured, for the same reason as the Apple
 * routes: endpoints that 500 on every call are worse than endpoints that are absent.
 */
export const createPointsRouter = (deps: PointsRouterDeps): Router => {
  const router = Router();
  const requireStaff = createRequireStaffKey(config.STAFF_API_KEY);

  /**
   * Turns the service's outcomes into HTTP.
   *
   * 200 rather than 201 even when a row was created: the meaningful result is the
   * member's balance, and a retry of the same operation returns the same body with
   * `applied: false`. A caller that retries is not doing anything wrong and should not
   * see an error.
   */
  const respond = async (
    res: Response,
    run: () => Promise<{
      applied: boolean;
      balance: { spendable: number; lifetime: number };
      tier: { code: string; label: string } | null;
    }>
  ): Promise<void> => {
    const outcome = await run();

    // 200 rather than 201 even when a row was created: the meaningful result is the
    // member's balance, and a retry of the same operation returns the same body with
    // `applied: false`. InsufficientPointsError is an AppError, so the error handler
    // turns it into a 409 without this layer knowing.
    res.status(200).json({
      applied: outcome.applied,
      balance: outcome.balance,
      tier: outcome.tier ? { code: outcome.tier.code, label: outcome.tier.label } : null
    });
  };

  /** safeParse, matching the rest of the API: a ZodError must never reach the client. */
  const parse = <T>(schema: ZodType<T>, body: unknown): T => {
    const parsed = schema.safeParse(body);

    if (!parsed.success) {
      throw new PointsValidationError(
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      );
    }

    return parsed.data;
  };

  const clinicFor = async (req: Request): Promise<string> => {
    const clinicId = await deps.clinicOfMember(req.params.memberId);

    if (!clinicId) throw new MemberNotFoundError(req.params.memberId);

    return clinicId;
  };

  router.post(
    "/members/:memberId/points/credit",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicFor(req);
      const input = parse(creditSchema, req.body);

      await respond(res, () =>
        deps.points.credit({
          memberId: req.params.memberId,
          clinicId,
          ...input
        })
      );
    })
  );

  router.post(
    "/members/:memberId/points/redeem",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicFor(req);
      const input = parse(redeemSchema, req.body);

      await respond(res, () =>
        deps.points.redeem({ memberId: req.params.memberId, clinicId, ...input })
      );
    })
  );

  router.post(
    "/members/:memberId/points/claw-back",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicFor(req);
      const input = parse(clawBackSchema, req.body);

      await respond(res, () =>
        deps.points.clawBack({ memberId: req.params.memberId, clinicId, ...input })
      );
    })
  );

  return router;
};
