import type { PrismaClient } from "@prisma/client";

import { logger } from "../../common/logger/logger";
import { toEngineCatalog, type CatalogRepository } from "../onboarding/catalog.repository";
import { classify } from "../onboarding/engine";
import type { ClassifiedItem } from "../onboarding/engine.types";
import { whatIf, type WhatIf, type WhatIfRequest, type WhatIfRow } from "./change-flag";
import {
  presentAdminFlag,
  presentOwnerFlag,
  type AdminFlag,
  type OwnerFlag
} from "./change-flag-present";
import type { PreviewFlagBody } from "./schema";

/**
 * Glue between a ticket (or an owner's draft of one) and the flag: finds the clinic's ACTIVE
 * programme and its current catalogue, asks `whatIf`, and presents the answer for one of two
 * audiences. The owner's is deliberately blurred and never says why there is no flag; the admin's
 * is exact and carries the reason (English).
 *
 * Total: nothing here throws. A flag is an aid, never a reason to refuse or hide a ticket.
 */

/** The programme row the simulation reads; the prisma `OnboardingProgram` satisfies it. */
export type ActiveRow = WhatIfRow;

export interface ChangeFlagDeps {
  /** The clinic's ACTIVE programme, or null. */
  active: (clinicId: string) => Promise<ActiveRow | null>;
  /** The clinic's catalogue as it is today, classified. */
  catalogue: (clinicId: string) => Promise<ClassifiedItem[]>;
  /** The catalogue row's `externalId` for a treatment id of THIS clinic, else null. */
  externalIdOf: (clinicId: string, treatmentId: string) => Promise<string | null>;
}

export type AdminFlagResult = (
  AdminFlag | { status: "unpriced"; itemName: string | null } | { status: "none"; reason: string }
) & {
  /** The reward item's name, for a REWARD ticket that names one, so the screen never shows a raw id. */
  itemName?: string | null;
};

/** What a ticket (or draft) is, as stored: the shapes are checked by the schema, but read defensively. */
export interface FlagSubject {
  type: string;
  targetRef: unknown;
  proposed: unknown;
}

/** The what-if is always five years; anything else is not shown rather than guessed at. */
const YEARS = 5;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const QUANTIZE_OWNER_PRICE = true;

/**
 * The owner's preview simulates the typed price rounded to the nearest 5 euros (never below 5).
 * Each blurred cell is linear in the price, so with 1-cent steps an owner could bisect for the
 * exact rounding edges and recover the gift's cost; on a 5-euro grid the same probing learns far
 * less. Voone's comparison keeps the exact ticket price.
 */
const quantizedPrice = (priceEuro: number): number => Math.max(5, Math.round(priceEuro / 5) * 5);

const none = (reason: string): WhatIf => ({ status: "none", reason });

export class ChangeFlagService {
  constructor(private readonly deps: ChangeFlagDeps) {}

  /** The owner's flag for a ticket they are about to send. Never throws: any error is `none`. */
  async preview(clinicId: string, body: PreviewFlagBody): Promise<OwnerFlag> {
    try {
      const result = await this.evaluate(clinicId, body, undefined, QUANTIZE_OWNER_PRICE);

      if (result.status === "unpriced") return { status: "unpriced" };
      if (result.status === "none") {
        return result.blocked ? { status: "blocked", kind: result.blocked } : { status: "none" };
      }
      if (result.years.length !== YEARS) return { status: "none" };

      // A recommendation rebuilt by today's engine (`reason`) is a plan Voone never made for this
      // clinic, so the owner is not compared with it: only the live row.
      const years =
        result.reason === null
          ? result.years
          : result.years.map((year) => ({ ...year, recommendedCumulative: null }));

      return presentOwnerFlag(years);
    } catch (error) {
      this.report("preview", error);

      return { status: "none" };
    }
  }

  /** The admin's exact comparison for a stored ticket. Never throws: any error is `none`. */
  async forTicket(clinicId: string, ticket: FlagSubject): Promise<AdminFlagResult> {
    try {
      const reward = ticket.type === "REWARD";
      const itemId = reward ? text(record(ticket.proposed).itemId) : undefined;
      // One read of the catalogue serves both the item's name and the simulation.
      const catalogue = itemId ? await this.deps.catalogue(clinicId) : undefined;
      const itemName =
        itemId && catalogue
          ? (catalogue.find((item) => item.id === itemId)?.name ?? null)
          : undefined;
      const result = await this.evaluate(clinicId, ticket, catalogue);
      const named = itemName === undefined ? {} : { itemName };

      if (result.status === "unpriced") return { status: "unpriced", itemName: itemName ?? null };
      if (result.status === "none") return { status: "none", reason: result.reason, ...named };

      if (result.years.length !== YEARS) {
        return { status: "none", reason: "The programme could not be simulated.", ...named };
      }

      return { ...presentAdminFlag(result.years, result.inputs, result.reason), ...named };
    } catch (error) {
      this.report("forTicket", error);

      return { status: "none", reason: "The comparison could not be computed." };
    }
  }

  private async evaluate(
    clinicId: string,
    subject: FlagSubject,
    known?: ClassifiedItem[],
    quantizePrice = false
  ): Promise<WhatIf> {
    if (subject.type !== "REWARD" && subject.type !== "SERVICE_EDIT") {
      return none("This type of request has no comparison.");
    }

    const row = await this.deps.active(clinicId);

    if (!row) return none("The clinic has no active programme.");

    const request = await this.requestOf(clinicId, subject, quantizePrice);

    if ("reason" in request) return none(request.reason);

    return whatIf(row, known ?? (await this.deps.catalogue(clinicId)), request);
  }

  /** The ticket as a what-if request, resolving a treatment id inside THIS clinic only. */
  private async requestOf(
    clinicId: string,
    subject: FlagSubject,
    quantizePrice: boolean
  ): Promise<WhatIfRequest | { reason: string }> {
    const target = record(subject.targetRef);
    const proposed = record(subject.proposed);

    if (subject.type === "REWARD") {
      return {
        type: "REWARD",
        milestone: number(proposed.milestone) ?? number(target.milestone),
        itemId: text(proposed.itemId),
        text: text(proposed.text)
      };
    }

    const priceEuro = number(proposed.priceEuro);

    if (priceEuro === undefined) return { reason: "The edit does not change the price." };

    // The simulation prices only the price; a rename or a new category would change how the item
    // is costed too, and that is not modelled, so say nothing rather than something wrong.
    if (proposed.categoryId !== undefined || proposed.name !== undefined) {
      return { reason: "Category and name changes are not modelled." };
    }

    const treatmentId = text(target.treatmentId) ?? text(proposed.treatmentId);
    const externalId = treatmentId ? await this.deps.externalIdOf(clinicId, treatmentId) : null;

    if (!externalId) return { reason: "That service is not in the clinic's catalogue." };

    return {
      type: "SERVICE_EDIT",
      externalId,
      priceEuro: quantizePrice ? quantizedPrice(priceEuro) : priceEuro
    };
  }

  private report(where: string, error: unknown): void {
    logger.error(`[change-flag] ${where} failed unexpectedly`, {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    });
  }
}

/** The service's real dependencies: the clinic's own rows, in the database, and nobody else's. */
export const prismaChangeFlagDeps = (
  db: PrismaClient,
  onboarding: { active: (clinicId: string) => Promise<ActiveRow | null> },
  catalog: CatalogRepository
): ChangeFlagDeps => ({
  active: (clinicId) => onboarding.active(clinicId),
  catalogue: async (clinicId) => classify(toEngineCatalog(await catalog.listForClinic(clinicId))),
  externalIdOf: async (clinicId, treatmentId) => {
    const row = await db.catalogItem.findFirst({
      where: { id: treatmentId, clinicId },
      select: { externalId: true }
    });

    return row?.externalId ?? null;
  }
});
