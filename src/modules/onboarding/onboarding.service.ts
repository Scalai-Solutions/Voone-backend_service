import {
  OnboardingProgramStatus,
  VisitKind,
  type OnboardingProgram,
  type PrismaClient
} from "@prisma/client";

import { AppError } from "../../common/errors/app-error";
import { toEngineCatalog, type CatalogRepository } from "./catalog.repository";
import { run } from "./engine";
import { CONFIG_VERSION, ENGINE_VERSION, FREQ_BUCKETS, TICKET_BUCKETS } from "./engine.config";
import { classify, estimate } from "./engine";
import type { Answers, EngineError, Program } from "./engine.types";
import { isEngineError } from "./engine.types";
import { recalibrationAdvice, type RecalibrationAdvice } from "./runtime/rules";
import { swapReward } from "./swap";

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
          output: program as unknown as object,
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
   * Refuses while the programme carries review notes. Those are raised only for things a
   * centre must actually resolve — unclassified rows, answers that contradict the
   * catalogue, a cost overrun — and publishing past them would put a programme in front
   * of members that Voone has already judged wrong.
   *
   * The previous version is marked SUSTITUIDO, never deleted: members progressed against
   * its thresholds and the record of what they were promised has to survive.
   */
  async publish(clinicId: string, programId: string): Promise<OnboardingProgram> {
    return this.prisma.$transaction(async (tx) => {
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
      const review = Array.isArray(output?.review) ? output.review : [];

      if (review.length) {
        throw new OnboardingError(
          `El programa tiene avisos que resolver antes de activarlo: ${review.join(" ")}`,
          409
        );
      }

      await tx.onboardingProgram.updateMany({
        where: { clinicId, status: OnboardingProgramStatus.ACTIVO },
        data: { status: OnboardingProgramStatus.SUSTITUIDO }
      });

      return tx.onboardingProgram.update({
        where: { id: draft.id },
        data: { status: OnboardingProgramStatus.ACTIVO, publishedAt: new Date() }
      });
    });
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
  async swapMilestone(
    clinicId: string,
    programId: string,
    milestone: number,
    alternative: number
  ): Promise<OnboardingProgram> {
    const row = await this.getProgram(clinicId, programId);

    if (row.status !== OnboardingProgramStatus.BORRADOR) {
      throw new OnboardingError(
        "Solo se pueden cambiar los premios de un borrador. Genera un borrador nuevo para editar un programa activo.",
        409
      );
    }

    const result = swapReward(
      row.output as unknown as Program,
      row.answers as unknown as Answers,
      milestone,
      alternative
    );

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
