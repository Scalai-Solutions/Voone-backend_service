import { describe, expect, it } from "vitest";

import { AppError, isAppError } from "../../src/common/errors/app-error";

class ExposedError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { statusCode: 422, code: "EXPOSED", expose: true, cause });
  }
}

class HiddenError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 503, code: "HIDDEN", expose: false });
  }
}

describe("AppError", () => {
  it("carries the status, code, and expose flag the error handler dispatches on", () => {
    const error = new ExposedError("nombre: es obligatorio");

    expect(error.statusCode).toBe(422);
    expect(error.code).toBe("EXPOSED");
    expect(error.expose).toBe(true);
    expect(error.message).toBe("nombre: es obligatorio");
  });

  it("names itself after the concrete subclass, so logs identify the failure", () => {
    expect(new HiddenError("boom").name).toBe("HiddenError");
  });

  it("preserves the underlying cause for logging without exposing it", () => {
    const cause = new Error("connect ECONNREFUSED");
    const error = new ExposedError("no disponible", cause);

    expect(error.cause).toBe(cause);
  });

  it("is a real Error, so stack traces and instanceof both work", () => {
    const error = new HiddenError("boom");

    expect(error).toBeInstanceOf(Error);
    expect(error.stack).toContain("HiddenError");
  });
});

describe("isAppError", () => {
  it("accepts any AppError subclass", () => {
    expect(isAppError(new ExposedError("x"))).toBe(true);
    expect(isAppError(new HiddenError("x"))).toBe(true);
  });

  it("rejects plain errors and non-errors, which must stay opaque to callers", () => {
    expect(isAppError(new Error("leaks DATABASE_URL"))).toBe(false);
    expect(isAppError(new TypeError("x"))).toBe(false);
    expect(isAppError({ statusCode: 400, code: "FAKE", expose: true })).toBe(false);
    expect(isAppError("boom")).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
  });
});
