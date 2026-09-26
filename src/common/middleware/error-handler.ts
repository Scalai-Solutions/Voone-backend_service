import type { ErrorRequestHandler } from "express";

import { isAppError } from "../errors/app-error";

/**
 * Turns a thrown error into a response.
 *
 * Previously this answered 500 to everything and echoed `error.message` whatever it
 * was, which made the whole AppError taxonomy decorative: ClinicNotFoundError's 404,
 * InsufficientPointsError's 409 and every validation 422 all reached the client as a
 * 500. Worse, `expose: false` did nothing — MemberNotFoundError is marked non-exposed
 * precisely so it does not echo an id back, and it was echoing it.
 *
 * Two rules now:
 *
 * - An AppError answers with its own status and code.
 * - Its message is returned only when `expose` says so. Anything else gets a generic
 *   line, and the real error is logged where operators can see it.
 */
const GENERIC: Record<number, string> = {
  400: "Bad request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  422: "Unprocessable entity",
  429: "Too many requests",
  503: "Service unavailable"
};

const generic = (status: number): string =>
  GENERIC[status] ?? (status >= 500 ? "Internal server error" : "Request failed");

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (isAppError(error)) {
    // 5xx is ours to explain, so it is logged even when it is a known error type.
    if (error.statusCode >= 500) {
      console.error(`[error] ${req.method} ${req.originalUrl}`, error);
    }

    res.status(error.statusCode).json({
      code: error.code,
      message: error.expose ? error.message : generic(error.statusCode)
    });

    return;
  }

  // Unrecognised: assume nothing about whether the message is safe to show.
  console.error(`[error] ${req.method} ${req.originalUrl}`, error);

  res.status(500).json({ code: "INTERNAL", message: generic(500) });
};
