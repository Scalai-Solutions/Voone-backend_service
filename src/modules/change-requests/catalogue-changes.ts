import { Prisma, type PrismaClient } from "@prisma/client";

import { BonoNotFoundError, BonoValidationError } from "../../common/errors/bono.errors";
import { ChangeRequestConflictError } from "../../common/errors/change-request.errors";
import {
  TreatmentNotFoundError,
  TreatmentValidationError
} from "../../common/errors/treatment.errors";
import { createPlan, removePlan, updatePlan, type BonoPlanRow } from "../bonos/bono-plan.service";
import {
  createTreatment,
  listTreatments,
  removeTreatment,
  updateTreatment,
  usesCatalogue,
  type TreatmentRow
} from "../treatments/treatment-catalogue.service";
import type { ChangeRequestDetail } from "./service";

/**
 * Applying a ticket to the catalogue, and telling the admin what it does to the live
 * programme. Everything goes through the same treatment and bono services the owner's routes
 * used before services became read-only, so validation and side effects are identical.
 * Messages here are for the admin, so they are English.
 */

export type AppliedAction = "created" | "updated" | "removed" | "deleted" | "retired";

export interface AppliedChange {
  kind: "treatment" | "bono";
  action: AppliedAction;
  /** One line, also used as the resolution note when the admin writes none. */
  summary: string;
  treatment?: TreatmentRow;
  bonoPlan?: BonoPlanRow;
}

export interface ImpactOptions {
  /** A transaction-bound client, to read the catalogue as it is before this change commits. */
  db?: PrismaClient;
  /** True once the change is (about to be) made: the wording changes from "will" to "changed". */
  applied?: boolean;
  /** The admin reads English; the centre, told about its own change, reads Spanish. */
  language?: "en" | "es";
}

export interface ApplyChangeOptions {
  /** For a SERVICE_ADD whose ticket has no category: where to file it. */
  categoryId?: string;
  /**
   * Let the catalogue's own refusals (Spanish, with their own status) through as they are, instead
   * of wrapping them in the admin's English conflict. For the centre making its own change.
   */
  plainErrors?: boolean;
}

export interface CatalogueChanges {
  /** Performs the ticket's change on `db`, a transaction-bound client. Throws a 409 on refusal. */
  apply(
    db: PrismaClient,
    ticket: ChangeRequestDetail,
    options?: ApplyChangeOptions
  ): Promise<AppliedChange>;
  /**
   * Whether applying needs a category from the admin: a SERVICE_ADD with none, still open, at a
   * centre whose treatments live in the catalogue (where every treatment has a category).
   */
  needsCategory(ticket: ChangeRequestDetail): Promise<boolean>;
  /**
   * Warnings about the clinic's ACTIVE programme, or null when there is nothing to say (no
   * active programme, or a ticket that does not touch the catalogue, or one already closed).
   */
  impact(ticket: ChangeRequestDetail, options?: ImpactOptions): Promise<string[] | null>;
}

export const APPLICABLE_TYPES: ReadonlySet<string> = new Set([
  "SERVICE_ADD",
  "SERVICE_EDIT",
  "SERVICE_REMOVE",
  "BONO"
]);

/**
 * The tickets a centre's own change files and applies in the same moment, with nobody at Voone in
 * between: treatments and bono plans. Rewards, levels and anything else still wait for Voone.
 */
export const AUTO_APPROVED_TYPES: ReadonlySet<string> = new Set([
  "SERVICE_ADD",
  "SERVICE_EDIT",
  "SERVICE_REMOVE",
  "BONO"
]);

/** Tickets that change the treatment catalogue the programme was built from. */
const CATALOGUE_TYPES: ReadonlySet<string> = new Set([
  "SERVICE_ADD",
  "SERVICE_EDIT",
  "SERVICE_REMOVE"
]);

const refused = (message: string) =>
  new ChangeRequestConflictError("CHANGE_REQUEST_APPLY_FAILED", message);

type Fields = Record<string, unknown>;

const fieldsOf = (value: unknown): Fields =>
  value && typeof value === "object" ? (value as Fields) : {};

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const only = (fields: Fields, keys: string[]): Fields =>
  Object.fromEntries(
    keys.filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]])
  );

const describe = (fields: Fields, labels: Record<string, string>): string =>
  Object.entries(labels)
    .filter(([key]) => fields[key] !== undefined)
    .map(([key, label]) =>
      typeof fields[key] === "number" && key === "priceEuro"
        ? `${label} -> ${fields[key]} EUR`
        : `${label} -> ${JSON.stringify(fields[key])}`
    )
    .join(", ");

const asRefusal = (error: unknown): never => {
  if (error instanceof TreatmentNotFoundError) {
    throw refused("The target treatment no longer exists at this clinic.");
  }

  if (error instanceof BonoNotFoundError) {
    throw refused("The target bono plan no longer exists at this clinic.");
  }

  if (error instanceof TreatmentValidationError || error instanceof BonoValidationError) {
    throw refused(`The proposed values are not valid for the catalogue: ${error.message}`);
  }

  throw error;
};

export class PrismaCatalogueChanges implements CatalogueChanges {
  constructor(private readonly db: PrismaClient) {}

  async needsCategory(ticket: ChangeRequestDetail): Promise<boolean> {
    if (
      ticket.type !== "SERVICE_ADD" ||
      ticket.status === "RESOLVED" ||
      ticket.status === "REJECTED"
    ) {
      return false;
    }

    if (str(fieldsOf(ticket.proposed).categoryId)) return false;

    return usesCatalogue(this.db, ticket.clinicId);
  }

  async apply(
    db: PrismaClient,
    ticket: ChangeRequestDetail,
    options: ApplyChangeOptions = {}
  ): Promise<AppliedChange> {
    const target = fieldsOf(ticket.targetRef);
    const proposed = fieldsOf(ticket.proposed);

    try {
      switch (ticket.type) {
        case "SERVICE_ADD":
          return await this.addTreatment(db, ticket.clinicId, proposed, options.categoryId);
        case "SERVICE_EDIT":
          return await this.editTreatment(db, ticket.clinicId, str(target.treatmentId), proposed);
        case "SERVICE_REMOVE":
          return await this.removeTreatment(db, ticket.clinicId, str(target.treatmentId));
        case "BONO":
          return await this.changeBono(db, ticket.clinicId, str(target.bonoId), proposed);
        default:
          throw refused(`Requests of type ${ticket.type} cannot be applied automatically.`);
      }
    } catch (error) {
      if (options.plainErrors) throw error;

      return asRefusal(error);
    }
  }

  async impact(ticket: ChangeRequestDetail, options: ImpactOptions = {}): Promise<string[] | null> {
    if (!CATALOGUE_TYPES.has(ticket.type)) return null;

    const applied = options.applied ?? false;

    if (!applied && (ticket.status === "RESOLVED" || ticket.status === "REJECTED")) return null;

    try {
      const db = options.db ?? this.db;
      const program = await db.onboardingProgram.findFirst({
        where: { clinicId: ticket.clinicId, status: "ACTIVO" },
        select: { version: true, output: true }
      });

      if (!program) return null;

      const spanish = options.language === "es";
      const warnings = [
        spanish
          ? `El catálogo ha cambiado desde que se creó el programa activo (v${program.version}): conviene recalibrarlo.`
          : applied
            ? `The catalogue changed since the active programme (v${program.version}) was built: consider recalibrating.`
            : `Applying this will change the catalogue compared with the active programme (v${program.version}): consider recalibrating.`
      ];
      const treatmentId = str(fieldsOf(ticket.targetRef).treatmentId);

      if (treatmentId) {
        const row = await db.catalogItem.findFirst({
          where: { id: treatmentId, clinicId: ticket.clinicId },
          select: { externalId: true }
        });

        if (row) warnings.push(...rewardsUsing(program.output, row.externalId, options.language));
      }

      return warnings;
    } catch (error) {
      // A malformed stored programme must not break reading a ticket; say nothing instead.
      console.error(
        `[change-requests] catalogue impact failed: ${error instanceof Error ? error.name : "Error"}`
      );

      return null;
    }
  }

  /* ---- treatments ---- */

  private async addTreatment(
    db: PrismaClient,
    clinicId: string,
    proposed: Fields,
    categoryOverride: string | undefined
  ): Promise<AppliedChange> {
    const treatment = await createTreatment(db, clinicId, {
      name: proposed.name as string,
      priceEuro: proposed.priceEuro as number,
      // What the owner asked for wins; the admin's category only fills in when there is none.
      categoryId: str(proposed.categoryId) ?? categoryOverride
    });

    return {
      kind: "treatment",
      action: "created",
      summary: `Added treatment "${treatment.name}" (${treatment.priceEuro} EUR)`,
      treatment
    };
  }

  private async existingTreatment(
    db: PrismaClient,
    clinicId: string,
    id: string | undefined
  ): Promise<TreatmentRow> {
    const before = id
      ? (await listTreatments(db, clinicId)).find((row) => row.id === id)
      : undefined;

    if (!before) throw new TreatmentNotFoundError();

    return before;
  }

  private async editTreatment(
    db: PrismaClient,
    clinicId: string,
    id: string | undefined,
    proposed: Fields
  ): Promise<AppliedChange> {
    const before = await this.existingTreatment(db, clinicId, id);
    const patch = only(proposed, ["name", "priceEuro", "categoryId"]);
    const treatment = await updateTreatment(db, clinicId, before.id, patch);

    return {
      kind: "treatment",
      action: "updated",
      summary: `Updated treatment "${before.name}" (${describe(patch, { name: "name", priceEuro: "price", categoryId: "category" })})`,
      treatment
    };
  }

  private async removeTreatment(
    db: PrismaClient,
    clinicId: string,
    id: string | undefined
  ): Promise<AppliedChange> {
    const before = await this.existingTreatment(db, clinicId, id);

    await removeTreatment(db, clinicId, before.id);

    return {
      kind: "treatment",
      action: "removed",
      summary: `Removed treatment "${before.name}"`,
      treatment: before
    };
  }

  /* ---- bono plans ---- */

  private async changeBono(
    db: PrismaClient,
    clinicId: string,
    id: string | undefined,
    proposed: Fields
  ): Promise<AppliedChange> {
    const action = proposed.action;

    if (action === "add") {
      const bonoPlan = await createPlan(db, clinicId, {
        name: proposed.name as string,
        priceEuro: proposed.priceEuro as number,
        totalSessions: proposed.totalSessions as number
      });

      return {
        kind: "bono",
        action: "created",
        summary: `Added bono plan "${bonoPlan.name}" (${bonoPlan.totalEuro} EUR, ${bonoPlan.totalSessions} sessions)`,
        bonoPlan
      };
    }

    const before = id ? await db.bonoPlan.findFirst({ where: { id, clinicId } }) : null;

    if (!before) throw new BonoNotFoundError();

    if (action === "edit") {
      const patch = only(proposed, ["name", "priceEuro", "totalSessions"]);
      const bonoPlan = await updatePlan(db, clinicId, before.id, patch);

      return {
        kind: "bono",
        action: "updated",
        summary: `Updated bono plan "${before.name}" (${describe(patch, { name: "name", priceEuro: "price", totalSessions: "sessions" })})`,
        bonoPlan
      };
    }

    if (action === "remove") {
      const { status } = await removePlan(db, clinicId, before.id);

      return {
        kind: "bono",
        action: status,
        summary:
          status === "deleted"
            ? `Deleted bono plan "${before.name}"`
            : `Retired bono plan "${before.name}" (members hold bonos from it)`
      };
    }

    throw refused("The request does not say whether to add, edit or remove a bono plan.");
  }
}

/** Live rewards whose items include the treatment (by the catalogue row's externalId). */
export const rewardsUsing = (
  output: Prisma.JsonValue,
  externalId: string,
  language: "en" | "es" = "en"
): string[] => {
  const program = fieldsOf(output);
  const uses = (option: unknown): boolean => {
    const items = fieldsOf(option).items;

    return Array.isArray(items) && items.some((item) => fieldsOf(item).id === externalId);
  };
  const title = (option: unknown, label: unknown): string => {
    const items = fieldsOf(option).items;
    const names = Array.isArray(items)
      ? items.map((item) => str(fieldsOf(item).name) ?? "").filter(Boolean)
      : [];

    return str(label) ?? names.join(" + ");
  };
  const lines: string[] = [];

  for (const reward of Array.isArray(program.chosen) ? program.chosen : []) {
    const { o, label, m } = fieldsOf(reward);

    if (uses(o)) {
      lines.push(
        language === "es"
          ? `El premio del hito ${String(fieldsOf(m).n)}, «${title(o, label)}», usa este tratamiento.`
          : `Milestone ${String(fieldsOf(m).n)} reward "${title(o, label)}" uses this treatment.`
      );
    }
  }

  const recurring = fieldsOf(program.rec);

  if (uses(recurring.o)) {
    lines.push(
      language === "es"
        ? `El premio recurrente, «${title(recurring.o, recurring.label)}», usa este tratamiento.`
        : `The recurring reward "${title(recurring.o, recurring.label)}" uses this treatment.`
    );
  }

  return lines;
};
