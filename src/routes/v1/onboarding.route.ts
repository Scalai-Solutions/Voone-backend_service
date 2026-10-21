import { Router } from "express";
import type { ZodType } from "zod";

import {
  ClinicNotFoundError,
  MembershipValidationError
} from "../../common/errors/membership.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import { calcDefaults, simulate5y, validateCalcInput } from "../../modules/onboarding/calculator";
import { parseCatalogCsv } from "../../modules/onboarding/catalog-csv";
import {
  toEngineCatalog,
  type CatalogRepository
} from "../../modules/onboarding/catalog.repository";
import { classify } from "../../modules/onboarding/engine";
import { TIERS } from "../../modules/onboarding/engine.config";
import type { CategoryCode, Program, TierCode } from "../../modules/onboarding/engine.types";
import {
  answersSchema,
  catalogPatchSchema,
  catalogReplaceSchema,
  csvImportSchema,
  redeemSchema,
  calculatorSchema,
  swapSchema,
  tierBenefitsSchema,
  visitSchema
} from "../../modules/onboarding/onboarding.schema";
import {
  OnboardingError,
  type OnboardingService
} from "../../modules/onboarding/onboarding.service";
import { presentProgram } from "../../modules/onboarding/presentation";
import type { RewardService } from "../../modules/onboarding/runtime/reward.service";
import type { VisitService } from "../../modules/onboarding/runtime/visit.service";

export interface OnboardingRouterDeps {
  onboarding: OnboardingService;
  catalog: CatalogRepository;
  /** Absent when the wallet subsystem is not configured: visits credit points through it. */
  visits?: VisitService;
  rewards?: RewardService;
  /** Resolves a poster slug to a clinic, or throws the 404 the rest of the API uses. */
  findClinic: (slug: string) => Promise<{ id: string }>;
  clinicExists: (clinicId: string) => Promise<boolean>;
}

/**
 * Onboarding a centre, and what happens once its programme is live.
 *
 * Two audiences behind one staff key, as in the dashboard routes. The staff key proves a
 * request came from the Voone app, not that the caller is an administrator; the frontend's
 * route handlers check the role before calling.
 *
 *  - /admin/clinics/:clinicId/onboarding/*  Voone's own view while onboarding a centre: the
 *    catalogue, the six answers, the draft programme, publishing. These answers include the
 *    internal figures, because Voone needs the cost of a programme to judge it.
 *  - /clinics/:slug/*  What a centre's own staff do day to day: record a visit, see and
 *    redeem a member's rewards. These never carry a cost, because the guide is explicit that
 *    costs are internal.
 */
export const createOnboardingRouter = (deps: OnboardingRouterDeps): Router => {
  const router = Router();
  const requireStaff = createRequireStaffKey(config.STAFF_API_KEY);

  const parse = <T>(schema: ZodType<T>, body: unknown): T => {
    const parsed = schema.safeParse(body);

    if (!parsed.success) {
      throw new MembershipValidationError(
        parsed.error.issues
          .map((issue) =>
            issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message
          )
          .join("; ")
      );
    }

    return parsed.data;
  };

  /** 404 for a clinic that does not exist, before anything else is said about it. */
  const clinicOr404 = async (clinicId: string): Promise<string> => {
    if (!(await deps.clinicExists(clinicId))) throw new ClinicNotFoundError(clinicId);

    return clinicId;
  };

  const requireVisits = (): VisitService => {
    if (!deps.visits) {
      throw new OnboardingError("Registrar visitas no está disponible en este entorno.", 503);
    }

    return deps.visits;
  };

  const requireRewards = (): RewardService => {
    if (!deps.rewards) {
      throw new OnboardingError("Los premios no están disponibles en este entorno.", 503);
    }

    return deps.rewards;
  };

  /**
   * A programme as the admin screen reads it: the centre-safe presentation, plus the
   * internal block Voone needs and a centre must never see.
   */
  const forAdmin = (row: {
    id: string;
    version: number;
    status: string;
    engineVersion: string;
    configVersion: string;
    publishedAt: Date | null;
    output: unknown;
    answers: unknown;
  }) => {
    const output = row.output as Program;

    return {
      id: row.id,
      version: row.version,
      status: row.status,
      engineVersion: row.engineVersion,
      configVersion: row.configVersion,
      publishedAt: row.publishedAt,
      // What the centre answered, so the screens can pre-fill when it comes back to a draft.
      answers: row.answers,
      program: presentProgram(output),
      internal: {
        costPct: output.costPct,
        guarantees: output.guarantees.map(([text, held]) => ({ text, held }))
      }
    };
  };

  /* -------------------------------------------------------------------------- catalogue */

  /**
   * The catalogue as the review screen needs it: each row with the category the engine
   * would give it and where that came from, so the centre can see why a row is filed where
   * it is and correct the ones it cannot classify.
   */
  const catalogView = async (clinicId: string) => {
    const rows = await deps.catalog.listForClinic(clinicId);
    const classified = new Map(classify(toEngineCatalog(rows)).map((c) => [c.id, c]));

    return rows.map((row) => {
      const c = classified.get(row.externalId);

      return {
        externalId: row.externalId,
        name: row.name,
        priceEuro: row.priceCents / 100,
        durationMin: row.durationMin,
        isProduct: row.isProduct,
        categoryId: row.categoryId,
        costPctOverride: row.costPctOverride,
        estimated: row.estimated,
        position: row.position,
        category: c?.cat ?? null,
        classifiedBy: c?.src ?? null,
        needsReview: Boolean(c?.review)
      };
    });
  };

  router.get(
    "/admin/clinics/:clinicId/onboarding/catalog",
    requireStaff,
    asyncHandler(async (req, res) => {
      res.json({ items: await catalogView(await clinicOr404(req.params.clinicId)) });
    })
  );

  router.put(
    "/admin/clinics/:clinicId/onboarding/catalog",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicOr404(req.params.clinicId);
      const body = parse(catalogReplaceSchema, req.body);

      await deps.catalog.replaceForClinic(
        clinicId,
        body.items.map((i) => ({ ...i, categoryId: i.categoryId ?? null }))
      );

      res.json({ items: await catalogView(clinicId) });
    })
  );

  router.patch(
    "/admin/clinics/:clinicId/onboarding/catalog/:externalId",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicOr404(req.params.clinicId);
      const patch = parse(catalogPatchSchema, req.body);
      const updated = await deps.catalog.updateItem(clinicId, req.params.externalId, patch);

      if (!updated) throw new OnboardingError("No existe esa fila del catálogo.", 404);

      res.json({ items: await catalogView(clinicId) });
    })
  );

  /**
   * Replaces the catalogue from a CSV the centre uploaded.
   *
   * Replaces rather than merges, because a catalogue is a complete statement of what the
   * centre sells. Bad rows are skipped and returned with their line and reason: one typo
   * must cost one row, not the import.
   */
  router.post(
    "/admin/clinics/:clinicId/onboarding/catalog/import",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicOr404(req.params.clinicId);
      const { csv } = parse(csvImportSchema, req.body);
      const result = parseCatalogCsv(csv);

      if (!result.items.length) {
        throw new OnboardingError(
          "No se ha podido leer ninguna fila. Cada línea necesita al menos nombre y precio, separados por punto y coma.",
          422
        );
      }

      if (result.items.length > 300) {
        throw new OnboardingError("El catálogo admite como máximo 300 filas.", 422);
      }

      await deps.catalog.replaceForClinic(clinicId, result.items);

      res.json({
        imported: result.items.length,
        skipped: result.skipped,
        notes: result.notes,
        items: await catalogView(clinicId)
      });
    })
  );

  /* ---------------------------------------------------------------- programme, step by step */

  router.get(
    "/admin/clinics/:clinicId/onboarding/estimates",
    requireStaff,
    asyncHandler(async (req, res) => {
      res.json(await deps.onboarding.estimatesFor(await clinicOr404(req.params.clinicId)));
    })
  );

  router.get(
    "/admin/clinics/:clinicId/onboarding/programs",
    requireStaff,
    asyncHandler(async (req, res) => {
      res.json({
        programs: await deps.onboarding.listPrograms(await clinicOr404(req.params.clinicId))
      });
    })
  );

  router.post(
    "/admin/clinics/:clinicId/onboarding/programs",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicOr404(req.params.clinicId);
      const answers = parse(answersSchema, req.body);
      const draft = await deps.onboarding.createDraft(clinicId, answers);

      res.status(201).json(forAdmin(draft));
    })
  );

  /**
   * The live preview: the programme these answers WOULD produce, stored nowhere.
   *
   * Declared before the :programId routes, because "preview" would otherwise be read as a
   * programme id.
   */
  router.post(
    "/admin/clinics/:clinicId/onboarding/preview",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicOr404(req.params.clinicId);
      const answers = parse(answersSchema, req.body);
      const program = await deps.onboarding.preview(clinicId, answers);

      res.json({
        program: presentProgram(program),
        internal: {
          costPct: program.costPct,
          guarantees: program.guarantees.map(([text, held]) => ({ text, held }))
        }
      });
    })
  );

  router.get(
    "/admin/clinics/:clinicId/onboarding/programs/:programId",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicOr404(req.params.clinicId);

      res.json(forAdmin(await deps.onboarding.getProgram(clinicId, req.params.programId)));
    })
  );

  router.post(
    "/admin/clinics/:clinicId/onboarding/programs/:programId/publish",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicOr404(req.params.clinicId);

      res.json(forAdmin(await deps.onboarding.publish(clinicId, req.params.programId)));
    })
  );

  /**
   * Five years of what a programme costs and brings in, for a number of clients and a ticket.
   *
   * Computed here rather than in the browser because it needs what every reward costs the
   * centre, and those figures never leave the server. Only yearly totals come back. It reads the
   * stored programme and never changes it: the calculator's ticket only changes how much the
   * simulated clients spend, not a single threshold or reward.
   */
  router.post(
    "/admin/clinics/:clinicId/onboarding/programs/:programId/calculator",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicOr404(req.params.clinicId);
      const body = parse(calculatorSchema, req.body ?? {});
      const row = await deps.onboarding.getProgram(clinicId, req.params.programId);
      const program = row.output as unknown as Program;
      const answers = row.answers as unknown as { members?: string };
      const defaults = calcDefaults(program, answers.members);
      const input = {
        clients: body.clients ?? defaults.clients,
        ticket: body.ticket ?? defaults.ticket
      };
      const problem = validateCalcInput(input);

      if (problem) throw new OnboardingError(problem, 422);

      res.json(simulate5y(program, input, defaults));
    })
  );

  router.patch(
    "/admin/clinics/:clinicId/onboarding/programs/:programId/milestones/:milestone",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicOr404(req.params.clinicId);
      const choice = parse(swapSchema, req.body);
      const milestone = Number(req.params.milestone);

      if (!Number.isInteger(milestone) || milestone < 1) {
        throw new MembershipValidationError("milestone: indica un número de hito válido");
      }

      res.json(
        forAdmin(
          await deps.onboarding.swapMilestone(clinicId, req.params.programId, milestone, choice)
        )
      );
    })
  );

  router.put(
    "/admin/clinics/:clinicId/onboarding/programs/:programId/tiers/:tier/benefits",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinicId = await clinicOr404(req.params.clinicId);
      const { benefits } = parse(tierBenefitsSchema, req.body);
      const tier = req.params.tier as TierCode;

      if (!TIERS.includes(tier)) {
        throw new MembershipValidationError("tier: indica un nivel válido");
      }

      res.json(
        forAdmin(
          await deps.onboarding.setTierBenefits(clinicId, req.params.programId, tier, benefits)
        )
      );
    })
  );

  router.get(
    "/admin/clinics/:clinicId/onboarding/recalibration",
    requireStaff,
    asyncHandler(async (req, res) => {
      res.json(await deps.onboarding.recalibrationFor(await clinicOr404(req.params.clinicId)));
    })
  );

  /* ----------------------------------------------------------------- a centre's own staff */

  /**
   * The centre's own catalogue for the visit form: name, price and category only. The review
   * view carries a per-item cost override, which a centre's staff must never see.
   */
  router.get(
    "/clinics/:slug/catalog",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);

      res.json({
        items: (await catalogView(clinic.id)).map((item) => ({
          externalId: item.externalId,
          name: item.name,
          priceEuro: item.priceEuro,
          category: item.category,
          isProduct: item.isProduct
        }))
      });
    })
  );

  /** The live programme as the centre sees it. No costs, by construction. */
  router.get(
    "/clinics/:slug/program",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);
      const live = await deps.onboarding.active(clinic.id);

      if (!live) throw new OnboardingError("El centro todavía no tiene un programa activo.", 404);

      res.json({
        version: live.version,
        publishedAt: live.publishedAt,
        program: presentProgram(live.output as unknown as Program)
      });
    })
  );

  router.post(
    "/clinics/:slug/members/:memberId/visits",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);
      const body = parse(visitSchema, req.body);

      const outcome = await requireVisits().record({
        clinicId: clinic.id,
        memberId: req.params.memberId,
        kind: body.kind,
        ...(body.kind === "PAYMENT"
          ? {
              lines: body.lines.map((l) => ({
                amountEuro: l.amountEuro,
                category: l.category as CategoryCode | undefined
              })),
              discountedProducts: body.discountedProducts
            }
          : { package: body.package }),
        idempotencyKey: body.idempotencyKey
      });

      // 200 for a retry as well as a first call, as the points routes do: a caller that
      // retries is not doing anything wrong and should not see an error.
      res.status(200).json(outcome);
    })
  );

  router.get(
    "/clinics/:slug/members/:memberId/rewards",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);

      res.json({ rewards: await requireRewards().listForMember(clinic.id, req.params.memberId) });
    })
  );

  router.post(
    "/clinics/:slug/members/:memberId/rewards/:rewardId/redeem",
    requireStaff,
    asyncHandler(async (req, res) => {
      const clinic = await deps.findClinic(req.params.slug);
      const body = parse(redeemSchema, req.body);

      res.json(
        await requireRewards().redeem({
          clinicId: clinic.id,
          memberId: req.params.memberId,
          rewardId: req.params.rewardId,
          visitId: body.visitId,
          surpriseItem: body.surpriseItem
        })
      );
    })
  );

  return router;
};
