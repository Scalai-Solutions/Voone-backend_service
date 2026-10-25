import { AppError } from "./app-error";

/**
 * What an owner typed for a treatment is not acceptable. The message is the Spanish copy the
 * editor shows next to the field, so it is exposed as is; it echoes nothing stored.
 */
export class TreatmentValidationError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 400, code: "TREATMENT_INVALID", expose: true });
  }
}

/**
 * No treatment with that id at this clinic. One answer for "does not exist" and "belongs to
 * another clinic", so an id cannot be probed across clinics. Exposed because the message is
 * fixed Spanish copy and echoes no id.
 */
export class TreatmentNotFoundError extends AppError {
  constructor() {
    super("No se ha encontrado ese tratamiento.", {
      statusCode: 404,
      code: "TREATMENT_NOT_FOUND",
      expose: true
    });
  }
}
