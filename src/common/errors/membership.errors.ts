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

/**
 * No member with that id, or one that has been erased.
 *
 * The two are deliberately one answer. Erasure overwrites the row in place so a future
 * ledger keeps its references, which means the row still exists — but saying so would
 * confirm that a given person was once a member of a named aesthetic clinic, which is
 * exactly what erasure is meant to prevent.
 *
 * Not exposed: the id is ours, and echoing it back tells a caller which ids are real.
 */
export class MemberNotFoundError extends AppError {
  constructor(memberId: string) {
    super(`Member "${memberId}" not found`, {
      statusCode: 404,
      code: "MEMBER_NOT_FOUND",
      expose: false
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

/** The slug is already taken. Slugs are printed on posters, so they cannot be reassigned. */
export class ClinicSlugTakenError extends AppError {
  constructor(slug: string) {
    super(`Clinic slug "${slug}" is already in use`, {
      statusCode: 409,
      code: "CLINIC_SLUG_TAKEN",
      // Safe: it echoes only the slug the caller sent, and the sign-up endpoint already
      // reveals whether a slug resolves.
      expose: true
    });
  }
}

/** The chosen template preset does not exist. */
export class TemplatePresetNotFoundError extends AppError {
  constructor(presetId: string) {
    super(`Template preset "${presetId}" not found`, {
      statusCode: 422,
      code: "TEMPLATE_PRESET_NOT_FOUND",
      expose: true
    });
  }
}
