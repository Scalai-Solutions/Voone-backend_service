import express, { type Express } from "express";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/common/errors/app-error";
import { MemberNotFoundError } from "../../src/common/errors/membership.errors";
import { InsufficientPointsError } from "../../src/common/errors/points.errors";
import { errorHandler } from "../../src/common/middleware/error-handler";

/**
 * Regression tests for a bug that made the whole AppError taxonomy decorative.
 *
 * The previous handler answered 500 to everything and echoed `error.message` whatever
 * it was, so ClinicNotFoundError's 404, InsufficientPointsError's 409 and every 422
 * reached callers as a 500 — confirmed in production, where
 * GET /api/v1/clinics/does-not-exist returned 500 with the clinic name in the body.
 */
class Exposed extends AppError {
  constructor() {
    super("the postcode is not a postcode", {
      statusCode: 422,
      code: "THING_INVALID",
      expose: true
    });
  }
}

class Hidden extends AppError {
  constructor() {
    super("signing key for pass.ai.voone.giftcard could not be decrypted", {
      statusCode: 503,
      code: "THING_UNAVAILABLE",
      expose: false
    });
  }
}

const appThrowing = (error: unknown): Express => {
  const app = express();

  app.get("/boom", () => {
    throw error;
  });
  app.use(errorHandler);

  return app;
};

const get = async (app: Express) => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/boom`);
    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
};

describe("errorHandler", () => {
  it("answers with the error's own status, not 500", async () => {
    const res = await get(appThrowing(new Exposed()));

    expect(res.status).toBe(422);
  });

  it("returns the code, so a caller can branch on it", async () => {
    const res = await get(appThrowing(new Exposed()));

    expect(res.body.code).toBe("THING_INVALID");
  });

  it("shows the message when the error says it is safe", async () => {
    const res = await get(appThrowing(new Exposed()));

    expect(res.body.message).toBe("the postcode is not a postcode");
  });

  it("withholds the message when the error says it is not", async () => {
    // The whole point of expose:false. This one names a certificate.
    const res = await get(appThrowing(new Hidden()));

    expect(res.status).toBe(503);
    expect(res.body.message).toBe("Service unavailable");
    expect(JSON.stringify(res.body)).not.toContain("giftcard");
  });

  it("does not echo a member id back on a 404", async () => {
    // MemberNotFoundError is expose:false precisely so a caller cannot learn which ids
    // are real by probing.
    const res = await get(appThrowing(new MemberNotFoundError("0d1f-real-id")));

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("0d1f-real-id");
  });

  it("maps InsufficientPointsError to 409 and keeps the numbers", async () => {
    const res = await get(appThrowing(new InsufficientPointsError(150, 100)));

    expect(res.status).toBe(409);
    expect(res.body.message).toContain("150");
    expect(res.body.message).toContain("100");
  });

  it("gives nothing away for an error it does not recognise", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await get(appThrowing(new Error("connect ECONNREFUSED 10.0.0.3:5432")));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: "INTERNAL", message: "Internal server error" });
    // Invisible to the caller, but an operator still needs it.
    expect(logged).toHaveBeenCalled();
  });

  it("logs a 5xx AppError too, since a server fault is ours to explain", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await get(appThrowing(new Hidden()));

    expect(logged).toHaveBeenCalled();
  });

  it("does not log an ordinary 4xx", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await get(appThrowing(new Exposed()));

    // A member mistyping a form is not an incident, and logging it buries the ones that
    // are.
    expect(logged).not.toHaveBeenCalled();
  });
});
