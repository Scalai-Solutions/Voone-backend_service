import { AppError } from "./app-error";

/**
 * The member cannot afford what was asked for.
 *
 * 409 rather than 422: the request is perfectly well formed and would succeed once the
 * member has earned more. A 4xx that says "fix your payload" would send the dashboard
 * looking for a bug that is not there.
 *
 * Exposed, including the numbers, because the person holding the till needs to say "you
 * have 100, that reward costs 150" — and both figures are the member's own, shown to
 * staff the member is standing in front of.
 */
export class InsufficientPointsError extends AppError {
  constructor(
    readonly requested: number,
    readonly spendable: number
  ) {
    super(`cannot redeem ${requested} points: member has ${spendable}`, {
      statusCode: 409,
      code: "INSUFFICIENT_POINTS",
      expose: true
    });
  }
}

/** The points movement does not satisfy the schema. */
export class PointsValidationError extends AppError {
  constructor(details: string) {
    super(details, {
      statusCode: 422,
      code: "POINTS_INVALID",
      // Safe: the message names fields and bounds, never stored data.
      expose: true
    });
  }
}
