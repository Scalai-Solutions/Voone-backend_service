import { Router, type Request, type Response } from "express";
import type { ZodType } from "zod";

import { MemberNotFoundError } from "../../common/errors/membership.errors";
import { PointsValidationError } from "../../common/errors/points.errors";
import { OnboardingError } from "../../modules/onboarding/onboarding.service";
import { MANUAL_POINTS_REFUSAL } from "../../modules/onboarding/runtime/program-tier.port";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import { POINTS_PER_EURO, toPoints } from "../../modules/onboarding/runtime/points-unit";
import { clawBackSchema, creditSchema, redeemSchema } from "../../modules/points/points.schema";
import type { PointsService } from "../../modules/points/points.service";

export interface PointsRouterDeps {
  points: PointsService;
  /** Resolves the member's clinic, and refuses a member who does not exist or is erased. */
  clinicOfMember: (memberId: string) => Promise<string | null>;
  /**
   * Whether a clinic runs an onboarding programme, in which case points are not added or
   * spent by hand. Optional so a deployment without programmes behaves exactly as before.
   */
  usesProgram?: (clinicId: string) => Promise<boolean>;
}

/**
 * Staff-only points movements.
 *
 * UNITS. A programme centre keeps progress in euros and every screen shows it times ten
 * (points-unit.ts). This API speaks the screens' unit at such a centre: balances in a response
 * are in points, and the amount of a request is read as points and converted to the euros the
 * ledger holds. A centre without a programme is untouched, raw both ways. At a programme centre
 * only claw-back is reachable (credit and redeem are refused), but all three go through the same
 * conversion so the route cannot drift. An amount that is not a whole euro of progress (not a
 * multiple of ten) is refused rather than rounded: a silent rounding would take back more or
 * fewer points than the person typed.
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
    programme: boolean,
    run: () => Promise<{
      applied: boolean;
      balance: { spendable: number; lifetime: number };
      tier: { code: string; label: string } | null;
    }>
  ): Promise<void> => {
    const outcome = await run();
    const shown = (progress: number): number => (programme ? toPoints(progress) : progress);

    // 200 rather than 201 even when a row was created: the meaningful result is the
    // member's balance, and a retry of the same operation returns the same body with
    // `applied: false`. InsufficientPointsError is an AppError, so the error handler
    // turns it into a 409 without this layer knowing.
    res.status(200).json({
      applied: outcome.applied,
      balance: {
        spendable: shown(outcome.balance.spendable),
        lifetime: shown(outcome.balance.lifetime)
      },
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

  const isProgramme = async (clinicId: string): Promise<boolean> =>
    deps.usesProgram ? deps.usesProgram(clinicId) : false;

  /** The request's amount in the ledger's unit: euros of progress at a programme centre. */
  const ledgerAmount = (points: number, programme: boolean): number => {
    if (!programme) return points;

    if (points % POINTS_PER_EURO !== 0) {
      throw new PointsValidationError(
        `points: at this centre points are ten per euro, so the amount must be a multiple of ${POINTS_PER_EURO}`
      );
    }

    return points / POINTS_PER_EURO;
  };

  const clinicFor = async (req: Request): Promise<string> => {
    const clinicId = await deps.clinicOfMember(req.params.memberId);

    if (!clinicId) throw new MemberNotFoundError(req.params.memberId);

    return clinicId;
  };

  /** Refuses a by-hand movement at a clinic that runs a programme. Claw-back is exempt. */
  const refuseIfProgram = async (clinicId: string): Promise<void> => {
    if (deps.usesProgram && (await deps.usesProgram(clinicId))) {
      throw new OnboardingError(MANUAL_POINTS_REFUSAL, 409);
    }
  };

  router.post(
    "/members/:memberId/points/credit",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicFor(req);
      await refuseIfProgram(clinicId);
      const input = parse(creditSchema, req.body);
      const programme = await isProgramme(clinicId);

      await respond(res, programme, () =>
        deps.points.credit({
          memberId: req.params.memberId,
          clinicId,
          ...input,
          points: ledgerAmount(input.points, programme)
        })
      );
    })
  );

  router.post(
    "/members/:memberId/points/redeem",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicFor(req);
      await refuseIfProgram(clinicId);
      const input = parse(redeemSchema, req.body);
      const programme = await isProgramme(clinicId);

      await respond(res, programme, () =>
        deps.points.redeem({
          memberId: req.params.memberId,
          clinicId,
          ...input,
          points: ledgerAmount(input.points, programme)
        })
      );
    })
  );

  router.post(
    "/members/:memberId/points/claw-back",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicFor(req);
      const input = parse(clawBackSchema, req.body);
      const programme = await isProgramme(clinicId);

      await respond(res, programme, () =>
        deps.points.clawBack({
          memberId: req.params.memberId,
          clinicId,
          ...input,
          points: ledgerAmount(input.points, programme)
        })
      );
    })
  );

  return router;
};
