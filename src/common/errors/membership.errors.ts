import { AppError } from "./app-error";

/**
 * The URL names a clinic that does not exist, is inactive, or is not a well-formed slug.
 * All three are one 404: a slug that fails the format could never have been seeded, and
 * an inactive clinic should not be confirmed to exist.
 */
export class ClinicNotFoundError extends AppError {
  constructor(slug: string) {
    super(`Clinic "${slug}" not found`, {
      statusCode: 404,
      code: "CLINIC_NOT_FOUND",
      // Safe: the message contains only the slug the caller already sent.
      expose: true
    });
  }
}

/** The submitted sign-up form does not satisfy the schema. */
export class MembershipValidationError extends AppError {
  constructor(details: string, cause?: unknown) {
    super(details, {
      statusCode: 422,
      code: "MEMBERSHIP_DATA_INVALID",
      // The message is the Spanish copy the form renders; it echoes nothing stored.
      expose: true,
      cause
    });
  }
}
