import { AppError } from "./app-error";

/**
 * The messages here are fixed Spanish copy the owner sees, and none of them echoes anything
 * stored, so every one is exposed.
 */

/** What was typed for a ticket is not acceptable. The message is the first problem. */
export class ChangeRequestValidationError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 422, code: "CHANGE_REQUEST_INVALID", expose: true });
  }
}

/**
 * No ticket with that id at this clinic. One answer for "does not exist" and "belongs to
 * another clinic", so an id cannot be probed across clinics.
 */
export class ChangeRequestNotFoundError extends AppError {
  constructor() {
    super("No se ha encontrado esa solicitud.", {
      statusCode: 404,
      code: "CHANGE_REQUEST_NOT_FOUND",
      expose: true
    });
  }
}

/**
 * The caller's role does not allow this. The frontend enforces the same rule; this is the
 * second lock, since the backend only knows the role because the frontend said so.
 */
export class ChangeRequestForbiddenError extends AppError {
  constructor(message = "No tienes permiso para gestionar solicitudes de cambio.") {
    super(message, { statusCode: 403, code: "CHANGE_REQUEST_FORBIDDEN", expose: true });
  }
}

/** The clinic already has as many unresolved tickets as it may have. */
export class ChangeRequestLimitError extends AppError {
  constructor(limit: number) {
    super(
      `Tienes ${limit} solicitudes abiertas. Espera a que Voone resuelva alguna antes de crear otra.`,
      { statusCode: 409, code: "CHANGE_REQUEST_LIMIT_REACHED", expose: true }
    );
  }
}

export type ChangeRequestConflictCode =
  | "CHANGE_REQUEST_INVALID_TRANSITION"
  | "CHANGE_REQUEST_REOPEN_WINDOW_CLOSED"
  | "CHANGE_REQUEST_NOT_CLOSED"
  | "CHANGE_REQUEST_STALE"
  | "CHANGE_REQUEST_ALREADY_CLOSED"
  | "CHANGE_REQUEST_NOT_APPLICABLE"
  | "CHANGE_REQUEST_APPLY_FAILED"
  | "CHANGE_REQUEST_NO_PROGRAMME"
  | "CHANGE_REQUEST_PROGRAMME_NOT_ACTIVE";

/** The ticket is not in a state that allows this. The code says which rule refused. */
export class ChangeRequestConflictError extends AppError {
  constructor(code: ChangeRequestConflictCode, message: string) {
    super(message, { statusCode: 409, code, expose: true });
  }
}

/** No programme with that id at this clinic. One answer for "absent" and "another clinic's". */
export class ProgrammeNotFoundError extends AppError {
  constructor() {
    super("Programme not found for this clinic.", {
      statusCode: 404,
      code: "PROGRAMME_NOT_FOUND",
      expose: true
    });
  }
}
