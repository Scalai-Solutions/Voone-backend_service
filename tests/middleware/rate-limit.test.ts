import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFixedWindowLimiter } from "../../src/common/middleware/rate-limit";

const WINDOW_MS = 600_000;

const call = (handler: ReturnType<typeof createFixedWindowLimiter>, ip: string) => {
  const req = { headers: { "cf-connecting-ip": ip }, params: {} } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn()
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;

  handler(req, res, next);

  return { res, next };
};

describe("createFixedWindowLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const limiter = () =>
    createFixedWindowLimiter({
      limit: 3,
      windowMs: WINDOW_MS,
      key: (req) => String(req.headers["cf-connecting-ip"])
    });

  it("passes requests up to the limit", () => {
    const handler = limiter();

    for (let i = 0; i < 3; i++) {
      expect(call(handler, "1.1.1.1").next).toHaveBeenCalledOnce();
    }
  });

  it("rejects the request after the limit with a Retry-After the client can honor", () => {
    const handler = limiter();

    for (let i = 0; i < 3; i++) call(handler, "1.1.1.1");
    const { res, next } = call(handler, "1.1.1.1");

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      code: "RATE_LIMITED",
      message: "Demasiados intentos. Inténtalo de nuevo en unos minutos."
    });
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", 600);
  });

  it("keys separately, so one clinic's traffic cannot block another's", () => {
    const handler = limiter();

    for (let i = 0; i < 4; i++) call(handler, "1.1.1.1");

    expect(call(handler, "2.2.2.2").next).toHaveBeenCalledOnce();
  });

  it("lets a blocked caller through once the window rolls over", () => {
    const handler = limiter();

    for (let i = 0; i < 4; i++) call(handler, "1.1.1.1");
    vi.advanceTimersByTime(WINDOW_MS + 1);

    expect(call(handler, "1.1.1.1").next).toHaveBeenCalledOnce();
  });

  it("sweeps expired buckets, so the key map is not itself a memory exhaustion vector", () => {
    // The key is attacker-controlled. Without a sweep, an unauthenticated endpoint would
    // let anyone grow this map without bound.
    const handler = createFixedWindowLimiter({
      limit: 1,
      windowMs: WINDOW_MS,
      maxBuckets: 50,
      key: (req) => String(req.headers["cf-connecting-ip"])
    });

    for (let i = 0; i < 60; i++) call(handler, `10.0.0.${i}`);
    expect(handler.bucketCount()).toBeGreaterThan(50);

    vi.advanceTimersByTime(WINDOW_MS + 1);
    for (let i = 100; i < 160; i++) call(handler, `10.0.1.${i}`);

    expect(handler.bucketCount()).toBeLessThanOrEqual(61);
  });
});
