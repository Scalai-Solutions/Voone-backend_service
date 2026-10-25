import type { Prisma } from "@prisma/client";

import { TemplateNotFoundError } from "../../common/errors/template.errors";
import type { prisma } from "../../infrastructure/database/prisma-client";

type DatabaseClient = Prisma.TransactionClient | typeof prisma;

/** The fields a clinic sees on its card, in the order a change is reported. */
const TRACKED_FIELDS = [
  "programName",
  "hexBackgroundColor",
  "logoUrl",
  "logoOnDarkUrl",
  "heroImageUrl",
  "websiteUrl",
  "appointmentUrl",
  "appLinkText",
  "appLinkDescription",
  "pointsLabel",
  "tierLabel",
  "benefitsText",
  "infoText"
] as const;

type TrackedField = (typeof TRACKED_FIELDS)[number];

export type TemplateFields = { [K in TrackedField]?: string | null };

/**
 * Mirrors what the repository writes: a blank optional field is stored as null, so a form
 * that re-sends a cleared field must not read as an edit.
 */
const OPTIONAL_FIELDS: ReadonlySet<TrackedField> = new Set([
  "logoUrl",
  "logoOnDarkUrl",
  "heroImageUrl",
  "websiteUrl",
  "appointmentUrl",
  "appLinkText",
  "appLinkDescription"
]);

const comparable = (field: TrackedField, value: string | null | undefined): string | null => {
  if (OPTIONAL_FIELDS.has(field)) {
    return value?.trim() ? value.trim() : null;
  }

  return value ?? null;
};

export const diffTemplate = (before: TemplateFields, after: TemplateFields): string[] =>
  TRACKED_FIELDS.filter(
    (field) => comparable(field, before[field]) !== comparable(field, after[field])
  );

/**
 * A template that is missing and one that belongs to another clinic throw the same error,
 * so the caller answers 404 for both and never confirms that a foreign id exists.
 */
export function assertOwnsTemplate(
  template: { id?: string; clinicId: string } | null,
  clinicId: string,
  templateId = template?.id ?? ""
): asserts template is { id?: string; clinicId: string } {
  if (!template || template.clinicId !== clinicId) {
    throw new TemplateNotFoundError(templateId);
  }
}

export interface TemplateChangeInput {
  clinicId: string;
  templateId: string;
  actor?: string;
  changedFields: string[];
  cardsAtSave: number;
}

export const recordTemplateChange = async (
  db: DatabaseClient,
  input: TemplateChangeInput
): Promise<void> => {
  await db.templateChange.create({
    data: {
      clinicId: input.clinicId,
      templateId: input.templateId,
      changedBy: input.actor ?? null,
      changedFields: input.changedFields,
      cardsAtSave: input.cardsAtSave
    }
  });
};
