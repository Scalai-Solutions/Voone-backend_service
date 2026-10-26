import { AppError } from "./app-error";

/**
 * What an owner typed for a bono plan is not acceptable. The message is the Spanish copy the
 * editor shows next to the field, so it is exposed as is; it echoes nothing stored.
 */
export class BonoValidationError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 422, code: "BONO_INVALID", expose: true });
  }
}

/**
 * No bono plan with that id at this clinic, or no bono with that id for that member. One
 * answer for "does not exist" and "belongs to another clinic", so an id cannot be probed
 * across clinics. Exposed because the message is fixed Spanish copy and echoes no id.
 */
export class BonoNotFoundError extends AppError {
  constructor() {
    super("No se ha encontrado ese bono.", {
      statusCode: 404,
      code: "BONO_NOT_FOUND",
      expose: true
    });
  }
}

/**
 * The bono exists but the request cannot be applied to it: no sessions left, already
 * cancelled, a session number already recorded. Spanish copy, exposed.
 */
export class BonoConflictError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 409, code: "BONO_CONFLICT", expose: true });
  }
}
