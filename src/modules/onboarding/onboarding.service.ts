import { OnboardingProgramStatus, type OnboardingProgram, type PrismaClient } from "@prisma/client";

import { toEngineCatalog, type CatalogRepository } from "./catalog.repository";
import { run } from "./engine";
import { CONFIG_VERSION, ENGINE_VERSION, FREQ_BUCKETS, TICKET_BUCKETS } from "./engine.config";
import { classify, estimate } from "./engine";
import type { Answers, EngineError, Program } from "./engine.types";
import { isEngineError } from "./engine.types";

/**
 * Generating, storing and publishing a centre's loyalty programme.
 *
 * The engine itself is pure and knows nothing about clinics or persistence. This is the
 * seam: it loads a catalogue, runs the engine, and keeps the result together with the
 * inputs that produced it so the programme can be audited and regenerated later.
 */

export class OnboardingError extends Error {
  readonly statusCode: number;
  readonly expose = true;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "OnboardingError";
    this.statusCode = statusCode;
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
}
