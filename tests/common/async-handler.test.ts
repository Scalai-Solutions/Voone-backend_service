import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { asyncHandler } from "../../src/common/middleware/async-handler";

const req = {} as Request;
const res = {} as Response;

describe("asyncHandler", () => {
  it("forwards a rejection to next, which Express 4 otherwise never observes", async () => {
    // Without this, the promise rejects unobserved: next is never called, no response is
    // written, and the request hangs until the proxy times out.
    const boom = new Error("database is down");
    const next = vi.fn() as unknown as NextFunction;

    await asyncHandler(async () => {
      throw boom;
    })(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });

  it("leaves a resolving handler alone", async () => {
    const next = vi.fn() as unknown as NextFunction;
    const handler = vi.fn().mockResolvedValue(undefined);

    await asyncHandler(handler)(req, res, next);

    expect(handler).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it("forwards a synchronous throw too", async () => {
    const next = vi.fn() as unknown as NextFunction;

    await asyncHandler(() => Promise.reject(new Error("sync-ish")))(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
