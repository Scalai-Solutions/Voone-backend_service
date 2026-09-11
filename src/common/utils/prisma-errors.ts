import { Prisma } from "@prisma/client";

/**
 * Whether an error is a unique constraint violation, optionally on specific fields.
 *
 * Checked structurally rather than with `instanceof`: two copies of @prisma/client in a
 * dependency tree, or a module boundary in the test runner, make `instanceof` silently
 * false, and a missed P2002 here turns a normal re-scan at reception into a 500.
 */
export const isUniqueViolation = (error: unknown, fields?: string[]): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  if ((error as { code?: unknown }).code !== "P2002") {
    return false;
  }

  if (!fields) {
    return true;
  }

  // Postgres usually reports a field list, but sometimes the constraint name instead
  // ("Member_clinicId_phone_key"). Both must match, because a false negative here makes
  // the service rethrow and turns an ordinary re-scan at reception into a 500.
  const target = (error as Prisma.PrismaClientKnownRequestError).meta?.target;

  if (Array.isArray(target)) {
    return fields.every((field) => target.includes(field));
  }

  if (typeof target === "string") {
    return fields.every((field) => target.includes(field));
  }

  // No usable detail. Claim the match rather than deny it: the caller re-reads the row
  // and rethrows if it is absent, so a wrong guess here fails safe.
  return true;
};
