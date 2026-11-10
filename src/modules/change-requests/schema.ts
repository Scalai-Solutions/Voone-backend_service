import { ChangeRequestStatus, ChangeRequestType } from "@prisma/client";
import { z } from "zod";

import { createBonoPlanSchema } from "../bonos/bono.schema";
import { createTreatmentSchema } from "../treatments/treatment-catalogue.service";

/**
 * What the change-request routes accept. Every message is Spanish copy for the screen that
 * shows it, like every other schema in this API; field names stay English.
 *
 * Every object is strict: an unknown key is an error, not something to drop, because a ticket
 * body that tries to carry `clinicId`, `status` or `createdByEmail` is either a bug or an
 * attack, and both deserve to be told no.
 */

export const TITLE_MAX = 120;
export const REASON_MIN = 3;
export const TEXT_MAX = 2000;
export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 50;

const UNKNOWN_FIELDS = "La solicitud contiene datos que no se pueden procesar.";
const strict = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject(shape, { error: UNKNOWN_FIELDS });
const UNKNOWN_FIELDS_EN = "The request contains fields that are not accepted.";
/** Admin-facing bodies answer in English; owner-facing ones in Spanish. */
const strictEn = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject(shape, { error: UNKNOWN_FIELDS_EN });

/* ---- text cleaning ---- */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// Everything except tab (09) and line feed (0a), which a written explanation legitimately has.
// eslint-disable-next-line no-control-regex
const CONTROL_KEEPING_BREAKS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** One line: breaks become spaces (so two words stay two words), other controls vanish. */
const oneLine = (value: string): string =>
  value
    .replace(/[\r\n\t]+/g, " ")
    .replace(CONTROL, "")
    .trim();

/** Free text: line breaks and tabs stay, CRLF is normalised, other controls vanish. */
const manyLines = (value: string): string =>
  value.replace(/\r\n?/g, "\n").replace(CONTROL_KEEPING_BREAKS, "").trim();

/**
 * Cleaned first, measured after: control characters must not pad a text past its minimum or
 * hide inside its maximum.
 */
const line = (min: number, max: number, message: string) =>
  z
    .string({ error: message })
    .transform(oneLine)
    .pipe(z.string().min(min, message).max(max, message));

const lines = (min: number, max: number, message: string) =>
  z
    .string({ error: message })
    .transform(manyLines)
    .pipe(z.string().min(min, message).max(max, message));

/* ---- structured parts ---- */

const ID_MESSAGE = "Identificador no válido.";
const id = line(1, 64, ID_MESSAGE);
const shortText = line(1, 120, "El texto debe tener entre 1 y 120 caracteres.");
const milestone = z
  .number({ error: "Indica un número de hito válido." })
  .int("Indica un número de hito válido.")
  .min(1, "Indica un número de hito válido.")
  .max(1000, "Indica un número de hito válido.");
const tier = line(1, 32, "Indica un nivel válido.");
const categoryId = line(1, 32, "Elige una categoría de la lista.");

/** The treatment and bono fields are the real write schemas', so applying a ticket maps 1:1. */
const treatmentName = z.string().transform(oneLine).pipe(createTreatmentSchema.shape.name);
const treatmentPrice = createTreatmentSchema.shape.priceEuro;
const bonoName = z.string().transform(oneLine).pipe(createBonoPlanSchema.shape.name);
const bonoPrice = createBonoPlanSchema.shape.priceEuro;
const bonoSessions = createBonoPlanSchema.shape.totalSessions;

const NOTHING_TO_CHANGE = "Indica al menos un cambio concreto.";

const atLeastOneOf = (keys: string[]) => (value: Record<string, unknown>) =>
  keys.some((key) => value[key] !== undefined);

const rewardTarget = strict({ milestone });
const rewardProposed = strict({
  milestone: milestone.optional(),
  text: shortText.optional(),
  itemId: id.optional()
});

const levelTarget = strict({ tier });
const levelProposed = strict({ tier: tier.optional(), text: shortText.optional() });

const treatmentTarget = strict({ treatmentId: id });
const serviceEditProposed = strict({
  treatmentId: id.optional(),
  name: treatmentName.optional(),
  priceEuro: treatmentPrice.optional(),
  categoryId: categoryId.optional(),
  prize: z.boolean().optional()
}).refine(atLeastOneOf(["name", "priceEuro", "categoryId", "prize"]), NOTHING_TO_CHANGE);
const serviceAddProposed = strict({
  name: treatmentName,
  priceEuro: treatmentPrice,
  categoryId: categoryId.optional(),
  prize: z.boolean().optional()
});
const serviceRemoveProposed = strict({ treatmentId: id.optional() });

const bonoTarget = strict({ bonoId: id });
const bonoProposed = z.discriminatedUnion(
  "action",
  [
    strict({
      action: z.literal("add"),
      name: bonoName,
      priceEuro: bonoPrice,
      totalSessions: bonoSessions
    }),
    strict({
      action: z.literal("edit"),
      bonoId: id.optional(),
      name: bonoName.optional(),
      priceEuro: bonoPrice.optional(),
      totalSessions: bonoSessions.optional()
    }).refine(atLeastOneOf(["name", "priceEuro", "totalSessions"]), NOTHING_TO_CHANGE),
    strict({ action: z.literal("remove"), bonoId: id.optional() })
  ],
  { error: "Indica si quieres añadir, editar o quitar un bono." }
);

const nothing = strict({});

interface TypeRule {
  /** Absent: this type has no target, so one is refused. */
  target?: z.ZodType<Record<string, unknown>>;
  /** Whether the target must be given, decided by the proposed values. */
  targetRequired?: (proposed: Record<string, unknown> | undefined) => boolean;
  proposed: z.ZodType<Record<string, unknown>>;
  proposedRequired?: boolean;
}

const RULES: Record<ChangeRequestType, TypeRule> = {
  REWARD: { target: rewardTarget, proposed: rewardProposed },
  LEVEL: { target: levelTarget, proposed: levelProposed },
  SERVICE_EDIT: {
    target: treatmentTarget,
    targetRequired: () => true,
    proposed: serviceEditProposed,
    proposedRequired: true
  },
  SERVICE_ADD: { proposed: serviceAddProposed, proposedRequired: true },
  SERVICE_REMOVE: {
    target: treatmentTarget,
    targetRequired: () => true,
    proposed: serviceRemoveProposed
  },
  BONO: {
    proposedRequired: true,
    target: bonoTarget,
    targetRequired: (proposed) => proposed?.action === "edit" || proposed?.action === "remove",
    proposed: bonoProposed as unknown as z.ZodType<Record<string, unknown>>
  },
  OTHER: { proposed: nothing }
};

const isEmpty = (value: Record<string, unknown>): boolean => Object.keys(value).length === 0;

export type ChangeRequestInput = z.output<typeof createChangeRequestSchema>;

const typeField = z.enum(ChangeRequestType, { error: "Elige un tipo de solicitud válido." });

/**
 * A new ticket. `targetRef` says what the request is about, `proposed` what the centre would
 * like instead; both are checked against the shape of the ticket's type, and an identifier
 * repeated in both must agree. An empty object means nothing and is stored as nothing.
 */
export const createChangeRequestSchema = strict({
  type: typeField,
  title: line(1, TITLE_MAX, `Escribe un título de hasta ${TITLE_MAX} caracteres.`),
  reason: lines(
    REASON_MIN,
    TEXT_MAX,
    `Explica el motivo de la solicitud (entre ${REASON_MIN} y ${TEXT_MAX} caracteres).`
  ),
  targetRef: z.unknown().optional(),
  proposed: z.unknown().optional()
}).transform((value, ctx) => {
  const rule = RULES[value.type];
  const fail = (message: string, path: Array<string | number>) => {
    ctx.addIssue({ code: "custom", message, path });
  };

  const readPart = (
    name: "targetRef" | "proposed",
    schema: z.ZodType<Record<string, unknown>> | undefined,
    raw: unknown
  ): Record<string, unknown> | undefined => {
    if (raw === undefined || raw === null) return undefined;

    if (!schema) {
      fail("Este tipo de solicitud no admite un elemento de referencia.", [name]);

      return undefined;
    }

    const parsed = schema.safeParse(raw);

    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        fail(issue.message, [name, ...issue.path.map(String)]);

      return undefined;
    }

    return isEmpty(parsed.data) ? undefined : parsed.data;
  };

  const targetRef = readPart("targetRef", rule.target, value.targetRef);
  const proposed = readPart("proposed", rule.proposed, value.proposed);

  if (rule.proposedRequired && value.proposed == null) {
    fail("Indica los datos del cambio que propones.", ["proposed"]);
  }

  if (rule.targetRequired?.(proposed) && targetRef === undefined) {
    fail("Indica sobre qué elemento quieres el cambio.", ["targetRef"]);
  }

  if (targetRef && proposed) {
    for (const key of Object.keys(targetRef)) {
      if (key in proposed && proposed[key] !== targetRef[key]) {
        fail("Los datos propuestos no coinciden con el elemento indicado.", ["proposed", key]);
      }
    }
  }

  if (proposed?.action === "add" && targetRef) {
    fail("Un bono nuevo no tiene un bono de referencia.", ["targetRef"]);
  }

  return { type: value.type, title: value.title, reason: value.reason, targetRef, proposed };
});

const PREVIEW_TYPES = ["REWARD", "SERVICE_EDIT"] as const;

/**
 * The owner's what-if preview: the two ticket types that can be simulated, with the very same
 * `targetRef` / `proposed` shapes as a ticket (so a body that would be refused as a ticket is
 * refused here too). No title or reason, and the clinic is never in the body.
 */
export const previewFlagSchema = strict({
  type: z.enum(PREVIEW_TYPES, {
    error: "Solo se puede simular un premio o el precio de un servicio."
  }),
  targetRef: z.unknown().optional(),
  proposed: z.unknown().optional()
}).transform((value, ctx) => {
  const rule = RULES[value.type];
  const fail = (message: string, path: Array<string | number>) => {
    ctx.addIssue({ code: "custom", message, path });
  };
  // Keep in step with createChangeRequestSchema: the same part shapes and the same rule that a key
  // repeated in targetRef and proposed must agree (a body refused as a ticket is refused here).
  const readPart = (
    name: "targetRef" | "proposed",
    schema: z.ZodType<Record<string, unknown>> | undefined,
    raw: unknown
  ): Record<string, unknown> | undefined => {
    if (raw === undefined || raw === null || !schema) return undefined;

    const parsed = schema.safeParse(raw);

    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        fail(issue.message, [name, ...issue.path.map(String)]);

      return undefined;
    }

    return isEmpty(parsed.data) ? undefined : parsed.data;
  };

  const targetRef = readPart("targetRef", rule.target, value.targetRef);
  const proposed = readPart("proposed", rule.proposed, value.proposed);

  if (rule.proposedRequired && value.proposed == null) {
    fail("Indica los datos del cambio que propones.", ["proposed"]);
  }

  if (rule.targetRequired?.(proposed) && targetRef === undefined) {
    fail("Indica sobre qué elemento quieres el cambio.", ["targetRef"]);
  }

  if (targetRef && proposed) {
    for (const key of Object.keys(targetRef)) {
      if (key in proposed && proposed[key] !== targetRef[key]) {
        fail("Los datos propuestos no coinciden con el elemento indicado.", ["proposed", key]);
      }
    }
  }

  return { type: value.type, targetRef, proposed };
});

export type PreviewFlagBody = z.output<typeof previewFlagSchema>;

const MESSAGE_ERROR = `Escribe un mensaje de hasta ${TEXT_MAX} caracteres.`;
const MESSAGE_ERROR_EN = `Write a message of up to ${TEXT_MAX} characters.`;

export const messageSchema = strict({ body: lines(1, TEXT_MAX, MESSAGE_ERROR) });

/** Voone's reply: same shape, English errors. */
export const adminMessageSchema = strictEn({ body: lines(1, TEXT_MAX, MESSAGE_ERROR_EN) });

/** Reopening may come with a word of explanation; it is never required. */
export const reopenSchema = strict({ message: lines(1, TEXT_MAX, MESSAGE_ERROR).optional() });

/**
 * Applying takes an optional note for the resolution (the ticket carries the change) and, for a
 * SERVICE_ADD that has no category, the category to create it in at a catalogue centre.
 */
export const applySchema = strictEn({
  note: lines(0, TEXT_MAX, MESSAGE_ERROR_EN).optional(),
  categoryId: line(1, 32, "Choose a category from the list.").optional()
});

/** A body that carries nothing: the ticket id in the path says it all. */
export const strictEmptySchema = strictEn({});

/** The note every ticket linked to a published programme is resolved with. */
export const resolveLinkedSchema = strictEn({
  note: lines(1, TEXT_MAX, "A resolution note is required (up to 2000 characters).")
});

export const statusUpdateSchema = strictEn({
  status: z.enum(ChangeRequestStatus, { error: "Invalid status." }),
  resolutionNote: z
    .string({ error: "The resolution note must be text." })
    .transform(manyLines)
    .pipe(z.string().max(TEXT_MAX, `The note admits up to ${TEXT_MAX} characters.`))
    .optional()
});

/* ---- paging ---- */

export interface ListCursor {
  createdAt: Date;
  id: string;
}

/** Opaque to callers: the last row's position, so the next page starts strictly after it. */
export const encodeCursor = (createdAt: Date, rowId: string): string =>
  Buffer.from(JSON.stringify({ t: createdAt.getTime(), i: rowId })).toString("base64url");

export const decodeCursor = (raw: string): ListCursor => {
  const parsed = z
    .object({ t: z.number().int().finite(), i: z.string().min(1).max(64) })
    .parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  const createdAt = new Date(parsed.t);

  if (Number.isNaN(createdAt.getTime())) throw new Error("bad cursor");

  return { createdAt, id: parsed.i };
};

/** The paging and filter fields, with the messages of one language. */
const listFields = (m: { cursor: string; limit: string; status: string }) => ({
  status: z.enum(ChangeRequestStatus, { error: m.status }).optional(),
  limit: z.coerce
    .number({ error: m.limit })
    .int(m.limit)
    .min(1, m.limit)
    .max(LIST_MAX_LIMIT, m.limit)
    .default(LIST_DEFAULT_LIMIT),
  cursor: z
    .string({ error: m.cursor })
    .max(200, m.cursor)
    .transform((raw, ctx) => {
      try {
        return decodeCursor(raw);
      } catch {
        ctx.addIssue({ code: "custom", message: m.cursor });

        return z.NEVER;
      }
    })
    .optional()
});

/** Query strings are not strict: a cache-busting parameter is not a mistake worth a 422. */
export const ownerListQuerySchema = z.object(
  listFields({
    cursor: "El cursor de paginación no es válido.",
    limit: `El límite debe estar entre 1 y ${LIST_MAX_LIMIT}.`,
    status: "Estado no válido."
  })
);

export const adminListQuerySchema = z.object({
  ...listFields({
    cursor: "The pagination cursor is not valid.",
    limit: `The limit must be between 1 and ${LIST_MAX_LIMIT}.`,
    status: "Invalid status."
  }),
  type: z.enum(ChangeRequestType, { error: "Invalid type." }).optional(),
  clinicId: line(1, 64, "Invalid clinic id.").optional(),
  q: z
    .string({ error: "The search must be text." })
    .transform(oneLine)
    .pipe(z.string().max(100, "The search admits up to 100 characters."))
    .transform((value) => value || undefined)
    .optional()
});
