import { z } from "zod";

import { ANSWER_LIMITS, CATEGORIES } from "./engine.config";

/**
 * What the onboarding and runtime routes accept.
 *
 * Messages are Spanish and written for the screen that shows them: a centre mistyping a price
 * reads "El precio tiene que ser un número", not a path into a JSON body. Bounds are generous
 * where a real centre would never reach them and exist to refuse a megabyte of junk, not to
 * second-guess a price list.
 */

const CATEGORY_CODES = Object.keys(CATEGORIES) as [string, ...string[]];

export const answersSchema = z.object({
  // Null or absent means "use your own estimate", which is the common case.
  ticket: z.enum(["t1", "t2", "t3", "t4"]).nullable().optional(),
  freq: z.enum(["f1", "f2", "f3", "f4", "f5"]).nullable().optional(),
  // The centre's own exact figures. They win over the buckets above. Null or absent means "use
  // the recommended value". The ranges are the founders': outside them a figure is almost
  // certainly a typo, and a typo here rebuilds the whole programme around it.
  ticketValue: z
    .number({ message: "El ticket medio tiene que ser un número" })
    .int("El ticket medio tiene que ser un número entero de euros")
    .min(ANSWER_LIMITS.ticket.min, "El ticket medio tiene que estar entre 10 y 1.000 €")
    .max(ANSWER_LIMITS.ticket.max, "El ticket medio tiene que estar entre 10 y 1.000 €")
    .nullable()
    .optional(),
  visitsValue: z
    .number({ message: "Las visitas al año tienen que ser un número" })
    .min(ANSWER_LIMITS.visits.min, "Las visitas al año tienen que estar entre 0,5 y 26")
    .max(ANSWER_LIMITS.visits.max, "Las visitas al año tienen que estar entre 0,5 y 26")
    // One decimal is all anyone can mean, and it keeps the stored answer reproducible.
    .transform((value) => Math.round(value * 10) / 10)
    .nullable()
    .optional(),
  objective: z.enum(["equilibrado", "mas_visitas", "mas_gasto", "mas_clientes_nuevos"], {
    message: "Elige un objetivo"
  }),
  investment: z.enum(["conservador", "equilibrado", "generoso"], {
    message: "Elige cuánto quieres devolver"
  }),
  occupancy: z.enum(["o1", "o2", "o3", "o4"], { message: "Indica la ocupación de la agenda" }),
  // The sixth question. Sizes an internal projection that is not ported, so it changes nothing
  // about the programme, but it is stored with the answers and must be well formed.
  members: z.enum(["m1", "m2", "m3", "m4"]).optional()
});

const catalogItemShape = {
  externalId: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1, "Falta el nombre").max(120, "El nombre es demasiado largo"),
  priceEuro: z
    .number({ message: "El precio tiene que ser un número" })
    .min(0, "El precio no puede ser negativo")
    .max(100_000, "El precio es demasiado alto"),
  durationMin: z.number().int().min(0).max(1440).nullable().optional(),
  isProduct: z.boolean().optional(),
  categoryId: z
    .string()
    .refine((value) => CATEGORY_CODES.includes(value), { message: "Categoría desconocida" })
    .nullable()
    .optional(),
  costPctOverride: z
    .number()
    .min(0, "El coste es un porcentaje entre 0 y 1")
    .max(1, "El coste es un porcentaje entre 0 y 1")
    .nullable()
    .optional(),
  estimated: z.boolean().optional()
};

export const catalogItemSchema = z.object(catalogItemShape);

/** A whole catalogue. Ids that repeat are refused: the engine breaks every tie on them. */
export const catalogReplaceSchema = z.object({
  items: z
    .array(catalogItemSchema)
    .max(300, "El catálogo admite como máximo 300 filas")
    .superRefine((items, ctx) => {
      const seen = new Set<string>();

      items.forEach((item, index) => {
        if (!item.externalId) return;

        if (seen.has(item.externalId)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "externalId"],
            message: `El identificador ${item.externalId} está repetido`
          });
        }

        seen.add(item.externalId);
      });
    })
});

export const catalogPatchSchema = z
  .object(catalogItemShape)
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: "No hay nada que cambiar" });

export const csvImportSchema = z.object({
  csv: z.string().min(1, "El archivo está vacío").max(400_000, "El archivo es demasiado grande")
});

const lineSchema = z.object({
  category: z
    .string()
    .refine((value) => CATEGORY_CODES.includes(value), { message: "Categoría desconocida" })
    .optional(),
  amountEuro: z
    .number({ message: "El importe tiene que ser un número" })
    .min(0, "El importe no puede ser negativo")
    .max(100_000, "El importe es demasiado alto")
});

const key = z.string().trim().min(8, "La clave de la operación es demasiado corta").max(80);

/**
 * A visit, as reception records it.
 *
 * Only a staff-typed visit is accepted: `source` is not a field here at all. The data model
 * reserves a QR scan and an integration, but until one of them exists nothing may claim to be
 * one, and the only way to guarantee that is to give the caller no way to say so.
 */
export const visitSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("PAYMENT"),
    lines: z.array(lineSchema).min(1, "Añade al menos un importe").max(50),
    discountedProducts: z.number().int().min(0).max(20).optional(),
    idempotencyKey: key
  }),
  z.object({
    kind: z.literal("BONO_SESSION"),
    package: z.object({
      name: z.string().trim().min(1).max(120).optional(),
      priceEuro: z.number().positive("El bono tiene que tener un precio"),
      sessions: z.number().int().min(1, "El bono tiene al menos una sesión").max(100)
    }),
    idempotencyKey: key
  })
]);

export const redeemSchema = z.object({
  visitId: z.string().min(1, "Indica la visita en la que se canjea"),
  surpriseItem: z.string().min(1).max(64).optional()
});

/** Both optional: an absent figure means "the default for this programme". */
export const calculatorSchema = z.object({
  clients: z.number({ message: "Los clientes tienen que ser un número" }).optional(),
  ticket: z.number({ message: "El ticket medio tiene que ser un número" }).optional()
});

export const swapSchema = z.object({
  alternative: z.number().int().min(0).max(1)
});

export type VisitBody = z.infer<typeof visitSchema>;
