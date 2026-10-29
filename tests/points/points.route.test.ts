import express, { type Express } from "express";
import { describe, expect, it } from "vitest";

import { InsufficientPointsError } from "../../src/common/errors/points.errors";
import { errorHandler } from "../../src/common/middleware/error-handler";
import type { PointsService } from "../../src/modules/points/points.service";
import { createPointsRouter } from "../../src/routes/v1/points.route";

const MEMBER = "member-1";
const CLINIC = "clinic-1";

interface Call {
  method: string;
  args: unknown;
}

/** Minimal fetch against the app, matching tests/wallet — no supertest dependency. */
const post = async (app: Express, path: string, body: unknown) => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
};

const buildApp = (
  overrides: Partial<Record<"credit" | "redeem" | "clawBack", unknown>> = {},
  programmeCentre?: boolean
) => {
  const calls: Call[] = [];

  const outcome = {
    applied: true,
    balance: { spendable: 300, lifetime: 500 },
    tier: { code: "silver", label: "Plata", minLifetimePoints: 500 }
  };

  const record =
    (method: "credit" | "redeem" | "clawBack") =>
    async (args: unknown): Promise<unknown> => {
      calls.push({ method, args });

      const override = overrides[method];

      if (override instanceof Error) throw override;

      return override ?? outcome;
    };

  const points = {
    credit: record("credit"),
    redeem: record("redeem"),
    clawBack: record("clawBack")
  } as unknown as PointsService;

  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1",
    createPointsRouter({
      points,
      clinicOfMember: async (memberId) => (memberId === MEMBER ? CLINIC : null),
      ...(programmeCentre === undefined ? {} : { usesProgram: async () => programmeCentre })
    })
  );
  // The real handler, not a stand-in: the status codes under test are produced by it.
  app.use(errorHandler);

  return { app, calls };
};

const credit = (body: unknown) => {
  const { app, calls } = buildApp();

  return { req: post(app, `/api/v1/members/${MEMBER}/points/credit`, body), calls };
};

describe("POST /members/:id/points/credit", () => {
  it("records the movement and returns the new balance", async () => {
    const res = await credit({ points: 100, idempotencyKey: "scan-abc-123" }).req;

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      applied: true,
      balance: { spendable: 300, lifetime: 500 },
      tier: { code: "silver", label: "Plata" }
    });
  });

  it("takes the clinic from the member, never from the body", async () => {
    // A staff caller must not be able to attribute a movement to another clinic.
    const { req, calls } = credit({
      points: 100,
      idempotencyKey: "scan-abc-123",
      clinicId: "some-other-clinic"
    });
    await req;

    expect((calls[0].args as { clinicId: string }).clinicId).toBe(CLINIC);
  });

  it("defaults the kind to EARN", async () => {
    const { req, calls } = credit({ points: 100, idempotencyKey: "scan-abc-123" });
    await req;

    expect((calls[0].args as { kind: string }).kind).toBe("EARN");
  });

  it("404s for a member that does not exist or has been erased", async () => {
    const { app } = buildApp();
    const res = await post(app, "/api/v1/members/ghost/points/credit", {
      points: 100,
      idempotencyKey: "scan-abc-123"
    });

    expect(res.status).toBe(404);
    // MemberNotFoundError is expose:false, so the id must not come back.
    expect(JSON.stringify(res.body)).not.toContain("ghost");
  });

  it("refuses REDEEM through the credit endpoint", async () => {
    // Redemption has to go through the path that checks affordability.
    const res = await credit({ points: 100, kind: "REDEEM", idempotencyKey: "scan-abc-123" }).req;

    expect(res.status).toBe(422);
  });

  it("refuses a negative, a zero and a fraction", async () => {
    for (const points of [-5, 0, 1.5]) {
      const res = await credit({ points, idempotencyKey: "scan-abc-123" }).req;

      expect(res.status, `points=${points}`).toBe(422);
    }
  });

  it("refuses an absurd amount, because a slipped keyboard is not a business event", async () => {
    const res = await credit({ points: 100_000_000, idempotencyKey: "scan-abc-123" }).req;

    expect(res.status).toBe(422);
  });

  it("requires an idempotency key, and a substantial one", async () => {
    expect((await credit({ points: 100 }).req).status).toBe(422);
    expect((await credit({ points: 100, idempotencyKey: "short" }).req).status).toBe(422);
  });
});

describe("POST /members/:id/points/redeem", () => {
  it("answers 409 when the member cannot afford it", async () => {
    const { app } = buildApp({ redeem: new InsufficientPointsError(150, 100) });

    const res = await post(app, `/api/v1/members/${MEMBER}/points/redeem`, {
      points: 150,
      idempotencyKey: "reward-abc-1"
    });

    // 409, not 422: the request is well formed and would succeed once they have earned
    // more. A 4xx meaning "fix your payload" would send the dashboard hunting a bug.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INSUFFICIENT_POINTS");
    // Exposed deliberately: reception has to say "you have 100, this costs 150".
    expect(res.body.message).toContain("100");
  });

  it("returns 200 with applied:false for a repeated redemption", async () => {
    const { app } = buildApp({
      redeem: { applied: false, balance: { spendable: 300, lifetime: 500 }, tier: null }
    });

    const res = await post(app, `/api/v1/members/${MEMBER}/points/redeem`, {
      points: 200,
      idempotencyKey: "reward-abc-1"
    });

    // A double tap at reception is not an error, and the correct answer is the one that
    // already happened.
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
  });
});

describe("POST /members/:id/points/claw-back", () => {
  const clawBack = (body: unknown) =>
    post(buildApp().app, `/api/v1/members/${MEMBER}/points/claw-back`, body);

  it("requires a reason, unlike the others", async () => {
    // Taking points back is the one movement a member would dispute, and "the system
    // did it" is not an answer reception can give.
    const res = await clawBack({ points: 100, idempotencyKey: "undo-abc-1" });

    expect(res.status).toBe(422);
  });

  it("accepts one with a reason", async () => {
    const res = await clawBack({
      points: 100,
      reason: "credited to the wrong member",
      idempotencyKey: "undo-abc-1"
    });

    expect(res.status).toBe(200);
  });
});

/**
 * A programme centre keeps progress in euros and every screen shows ten points per euro. The
 * API speaks the screens' unit there: amounts in, balances out. Elsewhere it is untouched.
 */
describe("units at a programme centre", () => {
  const clawBackPath = `/api/v1/members/${MEMBER}/points/claw-back`;

  it("takes a claw-back in points and records the euros", async () => {
    const { app, calls } = buildApp({}, true);

    const res = await post(app, clawBackPath, {
      points: 150,
      reason: "credited twice",
      idempotencyKey: "undo-abc-1"
    });

    expect(res.status).toBe(200);
    expect((calls[0].args as { points: number }).points).toBe(15);
  });

  it("answers in points: the ledger's 300 / 500 euros read 3000 / 5000", async () => {
    const { app } = buildApp({}, true);

    const res = await post(app, clawBackPath, {
      points: 150,
      reason: "credited twice",
      idempotencyKey: "undo-abc-1"
    });

    expect(res.body.balance).toEqual({ spendable: 3000, lifetime: 5000 });
  });

  it("refuses an amount that is not a whole euro of progress, rather than rounding it", async () => {
    const { app, calls } = buildApp({}, true);

    const res = await post(app, clawBackPath, {
      points: 155,
      reason: "credited twice",
      idempotencyKey: "undo-abc-1"
    });

    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it("leaves a centre without a programme exactly as it was", async () => {
    const { app, calls } = buildApp({}, false);

    const res = await post(app, clawBackPath, {
      points: 150,
      reason: "credited twice",
      idempotencyKey: "undo-abc-1"
    });

    expect((calls[0].args as { points: number }).points).toBe(150);
    expect(res.body.balance).toEqual({ spendable: 300, lifetime: 500 });
  });

  it("still refuses a by-hand credit or redemption at a programme centre", async () => {
    const { app, calls } = buildApp({}, true);

    const credited = await post(app, `/api/v1/members/${MEMBER}/points/credit`, {
      points: 100,
      idempotencyKey: "scan-abc-123"
    });
    const redeemed = await post(app, `/api/v1/members/${MEMBER}/points/redeem`, {
      points: 100,
      idempotencyKey: "scan-abc-124"
    });

    expect([credited.status, redeemed.status]).toEqual([409, 409]);
    expect(calls).toHaveLength(0);
  });
});
