import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { createRequireEdge } from "../../src/common/middleware/require-edge";

const call = (handler: ReturnType<typeof createRequireEdge>, headers: Record<string, string>) => {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;

  handler({ headers } as unknown as Request, res, next);

  return { res, next };
};

describe("createRequireEdge", () => {
  it("is a no-op when no secret is configured, so local dev and CI are unaffected", () => {
    expect(call(createRequireEdge(undefined), {}).next).toHaveBeenCalledOnce();
  });

  it("admits a request carrying the shared secret the edge injects", () => {
    const handler = createRequireEdge("s3cret-value-long-enough");

    expect(
      call(handler, { "x-voone-edge": "s3cret-value-long-enough" }).next
    ).toHaveBeenCalledOnce();
  });

  it("blocks a request that reached the origin directly", () => {
    // Railway exposes a hostname that bypasses Cloudflare. Without this, edge rate
    // limiting is theater and CF-Connecting-IP can be forged.
    const handler = createRequireEdge("s3cret-value-long-enough");
    const { res, next } = call(handler, {});

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("blocks a wrong secret without revealing anything about it", () => {
    const handler = createRequireEdge("s3cret-value-long-enough");
    const { res, next } = call(handler, { "x-voone-edge": "guess" });

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ code: "FORBIDDEN", message: "Forbidden" });
  });
});
