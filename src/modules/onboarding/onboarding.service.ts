import {
  OnboardingProgramStatus,
  Prisma,
  VisitKind,
  type OnboardingProgram,
  type PrismaClient
} from "@prisma/client";

import { AppError } from "../../common/errors/app-error";
import { refreshClinicCards } from "../wallet-refresh/clinic-card-refresh";
import {
  NO_VISIBLE_LINE,
  applyBenefitOverrides,
  visibleLineCount,
  type BenefitOverrideEntry
} from "./benefit-lines";
import { prizeSignature, toEngineCatalog, type CatalogRepository } from "./catalog.repository";
import { blockingReview, run } from "./engine";
import {
  ANSWER_LIMITS,
  CONFIG_VERSION,
  ENGINE_VERSION,
  FREQ_BUCKETS,
  TICKET_BUCKETS
} from "./engine.config";
import { classify, estimate, manualCandidates } from "./engine";
import type { Answers, CatalogItem, EngineError, Program, TierCode } from "./engine.types";
import { isEngineError } from "./engine.types";
import { placeMembersOnProgram } from "./runtime/placement";
import { parsePerkValues, PERK_VALUE_KEYS, type PerkValues } from "./runtime/savings";
import { recalibrationAdvice, type RecalibrationAdvice } from "./runtime/rules";
import {
  swapRecurring,
  swapReward,
  swapRewardToItem,
  swapRewardToSpecial,
  type PanelChoice,
  type SpecialChoice,
  type SwapResult
} from "./swap";
import { insertMilestone, removeMilestone } from "./ladder-edit";
import { moveMilestone, setRecurringEvery } from "./threshold";
import { applyTexts, type TextEdits } from "./texts";

/**
 * Generating, storing and publishing a centre's loyalty programme.
 *
 * The engine itself is pure and knows nothing about clinics or persistence. This is the
 * seam: it loads a catalogue, runs the engine, and keeps the result together with the
 * inputs that produced it so the programme can be audited and regenerated later.
 */

/**
 * A refusal the centre can act on.
 *
 * An AppError, not a plain Error, and that matters: the error handler answers 500 with a
 * generic message to anything it does not recognise, so a plain Error would turn every
 * "this reward has expired" into "Internal server error" and hide the one sentence a
 * receptionist needs. The message is Spanish copy written for the screen and echoes nothing
 * stored, so it is safe to expose.
 */
export class OnboardingError extends AppError {
  constructor(message: string, statusCode = 400) {
    super(message, { statusCode, code: `ONBOARDING_${statusCode}`, expose: true });
  }
}

/** What the questions screen needs: the engine's estimate and the buckets around it. */
export interface OnboardingEstimates {
  segment: string;
  ticketEstimate: number;
  visitsEstimate: number;
  annualSpend: number;
  preselectedTicketBucket: string;
  preselectedFreqBucket: string;
  /** The ranges the centre's own ticket and visits figures may take. */
  limits: { ticket: { min: number; max: number }; visits: { min: number; max: number } };
  ticketBuckets: Array<{ id: string; label: string; value: number }>;
  freqBuckets: Array<{ id: string; label: string }>;
  /** Rows the centre must categorise before a programme can be approved. */
  unclassified: Array<{ externalId: string; name: string }>;
}

export class OnboardingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly catalog: CatalogRepository
  ) {}

  /**
   * What the catalogue implies, before any answer is given.
   *
   * Runs only the first two engine steps. The questions screen needs the pre-selected
   * buckets to render at all, and running the whole engine — a seventeen-step relaxation
   * cascade — to fill in two dropdowns would make the screen slow for no reason.
   */
  async estimatesFor(clinicId: string): Promise<OnboardingEstimates> {
    const rows = await this.catalog.listForClinic(clinicId);

    if (!rows.length) {
      throw new OnboardingError(
        "El centro no tiene catálogo. Sube los tratamientos y productos antes de continuar."
      );
    }

    const classified = classify(toEngineCatalog(rows));
    const est = estimate(classified, {
      ticket: null,
      freq: null,
      objective: "equilibrado",
      investment: "equilibrado",
      occupancy: "o2"
    });

    if ("error" in est) throw new OnboardingError(est.error);

    const buckets = TICKET_BUCKETS[est.segment === "low" ? "low" : "mid"];

    return {
      segment: est.segment,
      ticketEstimate: est.tEst,
      visitsEstimate: est.fEst,
      annualSpend: est.A,
      preselectedTicketBucket: est.tPre,
      preselectedFreqBucket: est.fPre,
      limits: {
        ticket: { ...ANSWER_LIMITS.ticket },
        visits: { ...ANSWER_LIMITS.visits }
      },
      ticketBuckets: buckets.map((b) => ({ id: b.id, label: b.label, value: b.value })),
      freqBuckets: FREQ_BUCKETS.map((b) => ({ id: b.id, label: b.label })),
      unclassified: classified
        .filter((i) => i.review)
        .map((i) => ({ externalId: i.id, name: i.name }))
    };
  }

  /**
   * Generates a programme and stores it as the clinic's next draft version.
   *
   * The catalogue is snapshotted alongside the output. Without it the programme cannot be
   * reproduced: the engine reads prices and ids that the centre may edit the next day,
   * and "what exactly did this centre approve" has to stay answerable.
   */
  async createDraft(clinicId: string, answers: Answers): Promise<OnboardingProgram> {
    const rows = await this.catalog.listForClinic(clinicId);

    if (!rows.length) {
      throw new OnboardingError(
        "El centro no tiene catálogo. Sube los tratamientos y productos antes de generar el programa."
      );
    }

    const engineCatalog = toEngineCatalog(rows);
    const result = run(engineCatalog, answers);

    if (isEngineError(result)) {
      // The engine's refusals are written for the centre to read and act on, so they are
      // passed through rather than replaced with a generic message.
      throw new OnboardingError((result as EngineError).error);
    }

    const program = result as Program;

    // Read-then-write on the version number, inside the transaction that inserts. Two
    // operators generating a draft at the same moment would otherwise both read the same
    // highest version; the unique index on [clinicId, version] is what actually settles
    // it, and a retry is cheap because generating is pure.
    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.onboardingProgram.findFirst({
        where: { clinicId },
        orderBy: { version: "desc" },
        select: { version: true }
      });

      return tx.onboardingProgram.create({
        data: {
          clinicId,
          version: (latest?.version ?? 0) + 1,
          status: OnboardingProgramStatus.BORRADOR,
          engineVersion: ENGINE_VERSION,
          configVersion: CONFIG_VERSION,
          answers: answers as unknown as object,
          // The engine's untouched output rides inside the stored output as the baseline of the
          // five-year comparison. Replaying the snapshot later cannot stand in for it: the engine
          // has changed without a version bump, so a replay would show a difference nobody made.
          output: { ...program, recommended: structuredClone(program) } as unknown as object,
          catalogSnapshot: engineCatalog as unknown as object
        }
      });
    });
  }

  /**
   * Generates a programme WITHOUT storing it, for the live preview.
   *
   * The guide wants the preview to update as the centre changes an answer, and every
   * generation that persisted would mint a new version: a centre trying four investment
   * levels would leave four numbered drafts behind, and "version 14" would mean nothing to
   * anyone. So the preview computes and returns, and a draft is written only when the centre
   * commits to one. Same engine, same catalogue read, same refusals — only the insert is
   * skipped, so what the preview shows is exactly what saving would store.
   */
  async preview(clinicId: string, answers: Answers): Promise<Program> {
    const rows = await this.catalog.listForClinic(clinicId);

    if (!rows.length) {
      throw new OnboardingError(
        "El centro no tiene catálogo. Sube los tratamientos y productos antes de generar el programa."
      );
    }

    const result = run(toEngineCatalog(rows), answers);

    if (isEngineError(result)) throw new OnboardingError((result as EngineError).error);

    return result as Program;
  }

  /**
   * Whether the clinic marks prizes in its catalogue, and whether its live programme was built
   * with other answers than the catalogue holds now. A live programme is never changed by a
   * catalogue edit; this only says "it is worth regenerating" so the admin can do it on purpose.
   */
  async prizeStatus(clinicId: string): Promise<{ usesPrize: boolean; liveOutdated: boolean }> {
    const current = toEngineCatalog(await this.catalog.listForClinic(clinicId));
    const live = await this.active(clinicId);

    return {
      usesPrize: current.some((item) => item.prize !== undefined),
      liveOutdated:
        live !== null &&
        prizeSignature(current) !==
          prizeSignature((live.catalogSnapshot ?? []) as unknown as CatalogItem[])
    };
  }

  /** What the centre says each perk is worth to a member, in euros, for the savings total. */
  async perkValues(clinicId: string): Promise<Record<string, number | null>> {
    const clinic = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: { perkValues: true }
    });
    const stored = parsePerkValues(clinic.perkValues);

    return Object.fromEntries(
      PERK_VALUE_KEYS.map((key) => [key, stored[key] === undefined ? null : stored[key]! / 100])
    );
  }

  /**
   * Sets the value of the perks named, in euros; null or 0 clears one. Applies from the next
   * redemption: what members already saved was written with its own amount and is not touched.
   */
  async setPerkValues(
    clinicId: string,
    edits: Partial<Record<(typeof PERK_VALUE_KEYS)[number], number | null | undefined>>
  ): Promise<Record<string, number | null>> {
    const clinic = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: { perkValues: true }
    });
    const next: PerkValues = parsePerkValues(clinic.perkValues);

    for (const key of PERK_VALUE_KEYS) {
      const euros = edits[key];

      if (euros === undefined) continue;

      const cents = euros === null ? 0 : Math.round(euros * 100);

      if (cents > 0) next[key] = cents;
      else delete next[key];
    }

    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: { perkValues: Object.keys(next).length ? next : Prisma.DbNull }
    });

    return this.perkValues(clinicId);
  }

  /**
   * A new draft from the live programme's own answers and today's catalogue, so a change to the
   * Prize (Y/N) answers reaches the programme without the admin re-typing six answers. Only a
   * draft: nothing members see changes until the admin publishes it.
   */
  async redraftFromLive(clinicId: string): Promise<OnboardingProgram> {
    const live = await this.active(clinicId);

    if (!live) {
      throw new OnboardingError(
        "El centro todavía no tiene un programa activo del que partir. Genera un borrador con las respuestas.",
        409
      );
    }

    return this.createDraft(clinicId, live.answers as unknown as Answers);
  }

  /** The clinic's current draft, or null when it has none. */
  latestDraft(clinicId: string): Promise<OnboardingProgram | null> {
    return this.prisma.onboardingProgram.findFirst({
      where: { clinicId, status: OnboardingProgramStatus.BORRADOR },
      orderBy: { version: "desc" }
    });
  }

  /** The clinic's live programme, or null before it has published one. */
  active(clinicId: string): Promise<OnboardingProgram | null> {
    return this.prisma.onboardingProgram.findFirst({
      where: { clinicId, status: OnboardingProgramStatus.ACTIVO }
    });
  }

  /**
   * Makes a draft live, retiring whatever was live before.
   *
   * Refuses while the programme carries blocking review notes. Those are raised only for things a
   * centre must actually resolve — unclassified rows, answers that contradict the catalogue — and
   * publishing past them would put a programme in front of members that Voone has already judged
   * wrong. A cost overrun is told to the admin but does not block: she chose it with the number
   * in front of her.
   *
   * The previous version is marked SUSTITUIDO, never deleted: members progressed against
   * its thresholds and the record of what they were promised has to survive.
   */
  async publish(clinicId: string, programId: string): Promise<OnboardingProgram> {
    let replaced = false;

    const published = await this.prisma.$transaction(async (tx) => {
      const draft = await tx.onboardingProgram.findFirst({ where: { id: programId, clinicId } });

      if (!draft) throw new OnboardingError("No existe ese programa para este centro.", 404);

      if (draft.status === OnboardingProgramStatus.ACTIVO) return draft;

      if (draft.status === OnboardingProgramStatus.SUSTITUIDO) {
        throw new OnboardingError(
          "Ese programa ya fue sustituido por una versión posterior. Genera un borrador nuevo.",
          409
        );
      }

      const output = draft.output as unknown as Program;
      // The cost note is information, not a defect: it never blocks (see `INFORMATIONAL_NOTES`).
      const review = blockingReview(Array.isArray(output?.review) ? output.review : []);

      if (review.length) {
        throw new OnboardingError(
          `El programa tiene avisos que resolver antes de activarlo: ${review.join(" ")}`,
          409
        );
      }

      const superseded = await tx.onboardingProgram.updateMany({
        where: { clinicId, status: OnboardingProgramStatus.ACTIVO },
        data: { status: OnboardingProgramStatus.SUSTITUIDO }
      });

      replaced = superseded.count > 0;

      return tx.onboardingProgram.update({
        where: { id: draft.id },
        data: { status: OnboardingProgramStatus.ACTIVO, publishedAt: new Date() }
      });
    });

    // A new version replacing a live one: place each member on the new ladder by her progress,
    // which is stored in euros and so carries across. Rewards already issued stay valid until
    // their own expiry, and a step she has already passed on the new ladder is not issued again,
    // because issuing is judged on crossing. The first programme a centre ever publishes is left
    // alone, as migrating members who were on the old scheme is a separate, deliberate step.
    if (replaced) await placeMembersOnProgram(this.prisma, clinicId);

    // The card shows the programme's next reward, so a new live version changes every card.
    void refreshClinicCards(clinicId);

    return published;
  }

  /** Every version for a clinic, newest first. Metadata only: the output can be large. */
  listPrograms(clinicId: string) {
    return this.prisma.onboardingProgram.findMany({
      where: { clinicId },
      orderBy: { version: "desc" },
      select: {
        id: true,
        version: true,
        status: true,
        engineVersion: true,
        configVersion: true,
        publishedAt: true,
        createdAt: true
      }
    });
  }

  /** One programme, scoped to the clinic so another centre's id answers the same as none. */
  async getProgram(clinicId: string, programId: string): Promise<OnboardingProgram> {
    const row = await this.prisma.onboardingProgram.findFirst({
      where: { id: programId, clinicId }
    });

    if (!row) throw new OnboardingError("No existe ese programa para este centro.", 404);

    return row;
  }

  /**
   * Replaces one reward in a DRAFT with an alternative the engine proposed.
   *
   * Drafts only: a published programme is what members are climbing, so changing a reward in it
   * is not an edit but a new version, which the centre must ask for by generating a draft.
   *
   * Optimistic on the row's updatedAt. Two operators editing the same draft would otherwise
   * each read it, each swap a different reward, and the second write would silently erase the
   * first.
   */
  /** Replaces the benefits the centre wrote for one tier. Drafts only. */
  async setTierBenefits(
    clinicId: string,
    programId: string,
    tier: TierCode,
    benefits: string[]
  ): Promise<OnboardingProgram> {
    const row = await this.getProgram(clinicId, programId);

    if (row.status !== OnboardingProgramStatus.BORRADOR) {
      throw new OnboardingError(
        "Solo se pueden editar los beneficios de un borrador. Genera un borrador nuevo para editar un programa activo.",
        409
      );
    }

    const output = row.output as unknown as Program;
    const next: Program = {
      ...output,
      customBenefits: { ...(output.customBenefits ?? {}), [tier]: benefits }
    };

    // Removing the last line the centre wrote while every generated one is hidden would leave the
    // tier with nothing to show: see NO_VISIBLE_LINE.
    if (visibleLineCount(tier, next) === 0) throw new OnboardingError(NO_VISIBLE_LINE, 422);

    const updated = await this.prisma.onboardingProgram.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt },
      data: { output: next as unknown as object }
    });

    if (updated.count === 0) {
      throw new OnboardingError(
        "El borrador ha cambiado mientras lo editabas. Recarga la página y vuelve a intentarlo.",
        409
      );
    }

    return this.getProgram(clinicId, programId);
  }

  /**
   * Changes the words of, or hides, the lines the engine generates for one tier. Drafts only.
   *
   * Display only: the override is stored next to the programme (`benefitOverrides`) and read only
   * when the programme is presented, so the multiplier, the discount and every other rule behave
   * exactly as generated. Same rules as the other draft edits: BORRADOR only (409), optimistic on
   * updatedAt, and a key the tier does not have is 422 with nothing stored.
   */
  async setBenefitOverrides(
    clinicId: string,
    programId: string,
    tier: TierCode,
    entries: BenefitOverrideEntry[]
  ): Promise<OnboardingProgram> {
    const row = await this.getProgram(clinicId, programId);

    if (row.status !== OnboardingProgramStatus.BORRADOR) {
      throw new OnboardingError(
        "Solo se pueden editar los beneficios de un borrador. Genera un borrador nuevo para editar un programa activo.",
        409
      );
    }

    const result = applyBenefitOverrides(row.output as unknown as Program, tier, entries);

    if (!result.ok) throw new OnboardingError(result.reason, 422);

    const updated = await this.prisma.onboardingProgram.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt },
      data: { output: result.program as unknown as object }
    });

    if (updated.count === 0) {
      throw new OnboardingError(
        "El borrador ha cambiado mientras lo editabas. Recarga la página y vuelve a intentarlo.",
        409
      );
    }

    return this.getProgram(clinicId, programId);
  }

  /**
   * Starts a new draft from a programme exactly as it stands, edits and all.
   *
   * `createDraft` re-runs the engine, which is right when the centre changes its answers and wrong
   * for "I want to edit this programme": the engine knows nothing of the benefits the centre wrote,
   * the rewards it swapped or the texts it changed, so a draft made that way silently starts from
   * the generated programme again. This copies the stored output, answers and catalogue snapshot
   * verbatim instead, so the new draft IS the source programme and every edit made on it is a
   * difference the admin can see.
   *
   * One draft at a time: a second would leave two numbered versions each claiming to be "the
   * next one", and the admin could not tell which to publish. Cloning a programme of another
   * clinic answers 404, the same as a programme that does not exist.
   */
  async cloneDraft(clinicId: string, programId: string): Promise<OnboardingProgram> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const source = await tx.onboardingProgram.findFirst({ where: { id: programId, clinicId } });

        if (!source) throw new OnboardingError("No existe ese programa para este centro.", 404);

        const draft = await tx.onboardingProgram.findFirst({
          where: { clinicId, status: OnboardingProgramStatus.BORRADOR },
          select: { version: true }
        });

        if (draft) {
          throw new OnboardingError(
            `Ya hay un borrador (versión ${draft.version}). Edítalo o actívalo antes de crear otro.`,
            409
          );
        }

        const latest = await tx.onboardingProgram.findFirst({
          where: { clinicId },
          orderBy: { version: "desc" },
          select: { version: true }
        });

        return tx.onboardingProgram.create({
          data: {
            clinicId,
            version: (latest?.version ?? 0) + 1,
            status: OnboardingProgramStatus.BORRADOR,
            engineVersion: source.engineVersion,
            configVersion: source.configVersion,
            answers: source.answers as Prisma.InputJsonValue,
            output: source.output as Prisma.InputJsonValue,
            catalogSnapshot: source.catalogSnapshot as Prisma.InputJsonValue
          }
        });
      });
    } catch (error) {
      // Two simultaneous clones both pass the check above; the unique index on
      // [clinicId, version] lets one win, and the loser is told what the check would have.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new OnboardingError(
          "Ya hay un borrador. Recarga la página y edítalo o actívalo antes de crear otro.",
          409
        );
      }

      throw error;
    }
  }

  /**
   * Edits the words of a DRAFT: referral names, perk names and descriptions, and the titles of
   * rewards. Thresholds, items and the welcome progress stay as generated.
   *
   * Rewards already issued keep the title they were issued with (MemberReward.title is a
   * snapshot), so an edit changes only rewards issued after the draft is published.
   *
   * Same rules as the other draft edits: BORRADOR only (409), and optimistic on updatedAt so two
   * operators cannot silently overwrite each other. An index or milestone the programme does not
   * have is 422, and nothing is stored.
   */
  async setTexts(
    clinicId: string,
    programId: string,
    edits: TextEdits
  ): Promise<OnboardingProgram> {
    const row = await this.getProgram(clinicId, programId);

    if (row.status !== OnboardingProgramStatus.BORRADOR) {
      throw new OnboardingError(
        "Solo se pueden editar los textos de un borrador. Genera un borrador nuevo para editar un programa activo.",
        409
      );
    }

    const result = applyTexts(row.output as unknown as Program, edits);

    if (!result.ok) throw new OnboardingError(result.reason, 422);

    const updated = await this.prisma.onboardingProgram.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt },
      data: { output: result.program as unknown as object }
    });

    if (updated.count === 0) {
      throw new OnboardingError(
        "El borrador ha cambiado mientras lo editabas. Recarga la página y vuelve a intentarlo.",
        409
      );
    }

    return this.getProgram(clinicId, programId);
  }

  async swapMilestone(
    clinicId: string,
    programId: string,
    milestone: number,
    choice: { alternative: number } | { itemId: string } | SpecialChoice
  ): Promise<OnboardingProgram> {
    return this.editDraftProgram(
      clinicId,
      programId,
      "Solo se pueden cambiar los premios de un borrador. Genera un borrador nuevo para editar un programa activo.",
      async (program, answers) =>
        "alternative" in choice
          ? swapReward(program, answers, milestone, choice.alternative)
          : this.applyChoice(clinicId, program, answers, milestone, choice)
    );
  }

  /** Adds a reward to tier band `band` (1 to 4) at `realSpend` whole euros paid. Drafts only. */
  async addMilestone(
    clinicId: string,
    programId: string,
    band: number,
    realSpend: number,
    choice: { itemId: string } | SpecialChoice
  ): Promise<OnboardingProgram> {
    return this.editDraftProgram(
      clinicId,
      programId,
      "Solo se pueden añadir premios a un borrador. Genera un borrador nuevo para editar un programa activo.",
      async (program, answers) => {
        const slot = insertMilestone(program, band, realSpend);

        if (!slot.ok) return slot;

        return this.applyChoice(clinicId, slot.program, answers, slot.n, choice);
      }
    );
  }

  /** Removes a reward or perk from the ladder. Drafts only. */
  async removeMilestone(
    clinicId: string,
    programId: string,
    milestone: number
  ): Promise<OnboardingProgram> {
    return this.editDraftProgram(
      clinicId,
      programId,
      "Solo se pueden quitar premios de un borrador. Genera un borrador nuevo para editar un programa activo.",
      async (program) => removeMilestone(program, milestone)
    );
  }

  /** Sets the reward that repeats after Diamante to one of the "Cambiar" panel's choices. Drafts only. */
  async swapRecurringReward(
    clinicId: string,
    programId: string,
    choice: PanelChoice
  ): Promise<OnboardingProgram> {
    return this.editDraftProgram(
      clinicId,
      programId,
      "Solo se puede cambiar el premio de después de Diamante en un borrador. Genera un borrador nuevo para editar un programa activo.",
      async (program, answers) => {
        const ready = await this.forChoice(clinicId, program, answers, choice);

        return swapRecurring(ready.program, answers, choice, ready.pool);
      }
    );
  }

  /** Puts one of the "Cambiar" panel's choices in a milestone's reward slot. */
  private async applyChoice(
    clinicId: string,
    program: Program,
    answers: Answers,
    milestone: number,
    choice: PanelChoice
  ): Promise<SwapResult> {
    const ready = await this.forChoice(clinicId, program, answers, choice);

    return "itemId" in choice
      ? swapRewardToItem(ready.program, answers, milestone, choice.itemId)
      : swapRewardToSpecial(ready.program, answers, milestone, choice, ready.pool);
  }

  /**
   * What a panel choice is priced from. An item is read from the catalogue as it is today (see
   * `withCurrentRow`). A surprise may be anything the admin could hand-pick today (medical never),
   * read from the catalogue as it is now rather than the draft's snapshot, as an item swap does.
   */
  private async forChoice(
    clinicId: string,
    program: Program,
    answers: Answers,
    choice: PanelChoice
  ): Promise<{ program: Program; pool: ReturnType<typeof manualCandidates> }> {
    if ("itemId" in choice) {
      return { program: await this.withCurrentRow(clinicId, program, choice.itemId), pool: [] };
    }

    const pool =
      choice.kind === "sorpresa"
        ? manualCandidates(
            classify(toEngineCatalog(await this.catalog.listForClinic(clinicId))),
            answers
          )
        : [];

    return { program, pool };
  }

  /** Moves the spend at which a reward, a perk or a tier step is reached (whole euros paid). Drafts only. */
  async setMilestoneThreshold(
    clinicId: string,
    programId: string,
    milestone: number,
    realSpend: number
  ): Promise<OnboardingProgram> {
    return this.editDraftProgram(
      clinicId,
      programId,
      "Solo se puede cambiar el gasto de un borrador. Genera un borrador nuevo para editar un programa activo.",
      async (program) => moveMilestone(program, milestone, realSpend)
    );
  }

  /** How often the reward after Diamante comes round, in whole euros paid. Drafts only. */
  async setRecurringEvery(
    clinicId: string,
    programId: string,
    realSpend: number
  ): Promise<OnboardingProgram> {
    return this.editDraftProgram(
      clinicId,
      programId,
      "Solo se puede cambiar el gasto de un borrador. Genera un borrador nuevo para editar un programa activo.",
      async (program) => setRecurringEvery(program, realSpend)
    );
  }

  /**
   * One edit of a DRAFT's programme: refused on any other status, refused with the edit's own
   * reason, and written optimistically on the row's updatedAt, so two operators editing the same
   * draft cannot silently erase each other's change.
   */
  private async editDraftProgram(
    clinicId: string,
    programId: string,
    notDraft: string,
    edit: (program: Program, answers: Answers) => Promise<SwapResult>
  ): Promise<OnboardingProgram> {
    const row = await this.getProgram(clinicId, programId);

    if (row.status !== OnboardingProgramStatus.BORRADOR) throw new OnboardingError(notDraft, 409);

    const result = await edit(row.output as unknown as Program, row.answers as unknown as Answers);

    if (!result.ok) throw new OnboardingError(result.reason, 409);

    const updated = await this.prisma.onboardingProgram.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt },
      data: { output: result.program as unknown as object }
    });

    if (updated.count === 0) {
      throw new OnboardingError(
        "El borrador ha cambiado mientras lo editabas. Recarga la página y vuelve a intentarlo.",
        409
      );
    }

    return this.getProgram(clinicId, programId);
  }

  /**
   * The programme with `itemId` read from the centre's catalogue as it is today.
   *
   * `program.catalog` is a snapshot taken when the draft was generated. The swap picker lists
   * today's catalogue, so an item added or repriced since would be refused ("not in the
   * catalogue") or priced stale. The current row replaces the snapshot's (or is appended when the
   * snapshot never had it). An unknown id leaves the programme as it is: the swap then refuses
   * it by name. The stored programme is never touched here; the swap writes its own result.
   */
  private async withCurrentRow(
    clinicId: string,
    program: Program,
    itemId: string
  ): Promise<Program> {
    const rows = await this.catalog.listForClinic(clinicId);
    const current = classify(toEngineCatalog(rows)).find((item) => item.id === itemId);

    if (!current) return program;

    const copy = structuredClone(program);
    const at = copy.catalog.findIndex((item) => item.id === itemId);

    if (at < 0) copy.catalog.push(current);
    else copy.catalog[at] = current;

    return copy;
  }

  /**
   * Whether the centre's real numbers have drifted far enough from the programme's assumptions
   * to offer a recalibration.
   *
   * PROMPTED, never automatic — this only answers "is it worth asking". Measured from the
   * visits recorded since the programme went live: the average amount that earns progress per
   * payment, and how often a member who has visited comes back, per year.
   */
  async recalibrationFor(clinicId: string): Promise<
    RecalibrationAdvice & {
      measured: { ticket: number; visitsPerYear: number } | null;
      used: { ticket: number; visitsPerYear: number } | null;
      daysOfData: number;
    }
  > {
    const live = await this.active(clinicId);

    if (!live?.publishedAt) {
      return {
        offer: false,
        ticketDrift: 0,
        visitsDrift: 0,
        reason: "El centro todavía no tiene un programa activo.",
        measured: null,
        used: null,
        daysOfData: 0
      };
    }

    const output = live.output as unknown as Program;
    const daysOfData = Math.floor((Date.now() - live.publishedAt.getTime()) / 86_400_000);

    const payments = await this.prisma.paidVisit.aggregate({
      where: { clinicId, kind: VisitKind.PAYMENT, occurredAt: { gte: live.publishedAt } },
      _avg: { amountCents: true },
      _count: { _all: true }
    });
    const members = await this.prisma.paidVisit.groupBy({
      by: ["memberId"],
      where: { clinicId, occurredAt: { gte: live.publishedAt } }
    });

    const used = { ticket: output.est.ticket, visitsPerYear: output.est.visits };
    const measuredTicket = (payments._avg.amountCents ?? 0) / 100;
    const years = Math.max(daysOfData, 1) / 365;
    const measuredVisits = members.length ? payments._count._all / members.length / years : 0;

    const advice = recalibrationAdvice({
      usedTicket: used.ticket,
      usedVisits: used.visitsPerYear,
      measuredTicket,
      measuredVisits,
      daysOfData
    });

    return {
      ...advice,
      measured: payments._count._all
        ? { ticket: measuredTicket, visitsPerYear: measuredVisits }
        : null,
      used,
      daysOfData
    };
  }
}
