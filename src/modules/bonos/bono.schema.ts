import { z } from "zod";

/**
 * What the plan editor and the visit form accept for bonos. Messages are Spanish, written
 * for the screen that shows them, like every other schema in this API.
 */

export const PLAN_NAME_MESSAGE = "Escribe el nombre del bono.";
export const PLAN_PRICE_MESSAGE = "El precio del bono debe estar entre 0,01 € y 100.000 €.";
export const PLAN_DECIMALS_MESSAGE = "El precio por sesión admite como máximo dos decimales.";
export const PLAN_SESSIONS_MESSAGE = "El bono tiene entre 1 y 100 sesiones.";
export const BONO_START_AT_MESSAGE = "La sesión inicial tiene que estar entre 1 y las sesiones del bono.";
export const BONUS_POINTS_MESSAGE = "Los puntos extra deben ser múltiplos de 10 (10 puntos = 1 € de progreso).";

const NAME_MAX = 120;
const PRICE_MIN = 0.01;
const PRICE_MAX = 100_000;
export const BONO_SESSIONS_MIN = 1;
export const BONO_SESSIONS_MAX = 100;
/** Whole points per euro of progress, so bonus points stay on the ledger's integer grid. */
export const BONUS_STEP = 10;
export const BONUS_MAX_POINTS = 100_000;

const name = z
  .string({ error: PLAN_NAME_MESSAGE })
  .trim()
  .min(1, PLAN_NAME_MESSAGE)
  .max(NAME_MAX, `El nombre no puede tener más de ${NAME_MAX} caracteres.`);

/** The whole pack: what the client pays. The per-session figure is derived from it. */
const priceEuro = z
  .number({ error: PLAN_PRICE_MESSAGE })
  .refine(
    (value) => Number.isFinite(value) && value >= PRICE_MIN && value <= PRICE_MAX,
    PLAN_PRICE_MESSAGE
  )
  .refine(
    // At most two decimals, with a tolerance for the float error in value * 100.
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
    PLAN_DECIMALS_MESSAGE
  );

const totalSessions = z
  .number({ error: PLAN_SESSIONS_MESSAGE })
  .int(PLAN_SESSIONS_MESSAGE)
  .min(BONO_SESSIONS_MIN, PLAN_SESSIONS_MESSAGE)
  .max(BONO_SESSIONS_MAX, PLAN_SESSIONS_MESSAGE);

/** Owner input: the pack's total price and its session count. */
export const createBonoPlanSchema = z.object({ name, priceEuro, totalSessions });

export const updateBonoPlanSchema = z
  .object({
    name: name.optional(),
    priceEuro: priceEuro.optional(),
    totalSessions: totalSessions.optional(),
    active: z.boolean().optional()
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "No hay nada que cambiar" });

/**
 * "Empezar en la sesión N", for a client who already did sessions elsewhere before the
 * bono was tracked here. The upper bound is checked against the plan at runtime.
 */
export const startAtSessionSchema = z
  .number({ error: BONO_START_AT_MESSAGE })
  .int(BONO_START_AT_MESSAGE)
  .min(BONO_SESSIONS_MIN, BONO_START_AT_MESSAGE)
  .max(BONO_SESSIONS_MAX, BONO_START_AT_MESSAGE);

/**
 * Bonus points recorded with a visit. Points are ten per euro of progress and the ledger
 * holds whole euros, so anything not a multiple of 10 could not be represented honestly.
 */
export const bonusPointsSchema = z
  .number({ error: BONUS_POINTS_MESSAGE })
  .int(BONUS_POINTS_MESSAGE)
  .min(BONUS_STEP, BONUS_POINTS_MESSAGE)
  .max(BONUS_MAX_POINTS, BONUS_POINTS_MESSAGE)
  .refine((value) => value % BONUS_STEP === 0, BONUS_POINTS_MESSAGE);

export type CreateBonoPlanInput = z.input<typeof createBonoPlanSchema>;
export type UpdateBonoPlanInput = z.input<typeof updateBonoPlanSchema>;
