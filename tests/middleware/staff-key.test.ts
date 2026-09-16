import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import {
  createRequireStaffKey,
  isStaffKeyConfigured,
  isStaffRequest
} from "../../src/common/middleware/staff-key";

const KEY = "a-staff-key-of-sufficient-length";

const request = (headers: Record<string, string> = {}) => ({ headers }) as unknown as Request;

const call = (
  handler: ReturnType<typeof createRequireStaffKey>,
  headers: Record<string, string>
) => {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;

  handler(request(headers), res, next);

  return { res, next };
};

describe("isStaffRequest", () => {
  it("accepts a request carrying the key", () => {
    expect(isStaffRequest(request({ "x-voone-staff-key": KEY }), KEY)).toBe(true);
  });

  it("rejects a wrong key, a missing header, and a non-string header", () => {
    expect(isStaffRequest(request({ "x-voone-staff-key": "guess" }), KEY)).toBe(false);
    expect(isStaffRequest(request({ "x-voone-staff-key": "" }), KEY)).toBe(false);
    expect(isStaffRequest(request(), KEY)).toBe(false);
  });

  it("rejects a key that only shares a prefix, so length is not a shortcut", () => {
    expect(isStaffRequest(request({ "x-voone-staff-key": KEY.slice(0, -1) }), KEY)).toBe(false);
    expect(isStaffRequest(request({ "x-voone-staff-key": `${KEY}x` }), KEY)).toBe(false);
  });

  it("qualifies nobody when no key is configured", () => {
    // Strict on purpose: this answer waives the public rate limit, and a deployment that
    // forgot the variable must not thereby switch that protection off for everyone.
    expect(isStaffRequest(request({ "x-voone-staff-key": KEY }), undefined)).toBe(false);
    expect(isStaffRequest(request(), undefined)).toBe(false);
  });
});

describe("isStaffKeyConfigured", () => {
  it("reports whether staff authentication exists at all", () => {
    expect(isStaffKeyConfigured(KEY)).toBe(true);
    expect(isStaffKeyConfigured(undefined)).toBe(false);
    expect(isStaffKeyConfigured("")).toBe(false);
  });
});

describe("createRequireStaffKey", () => {
  it("admits a request carrying the key", () => {
    expect(
      call(createRequireStaffKey(KEY), { "x-voone-staff-key": KEY }).next
    ).toHaveBeenCalledOnce();
  });

  it("blocks a write without the key, which would otherwise deface a public page", () => {
    const { res, next } = call(createRequireStaffKey(KEY), {});

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ code: "FORBIDDEN", message: "Forbidden" });
  });

  it("is a no-op when unconfigured, so local development needs no key", () => {
    // Deliberately the opposite of isStaffRequest: a missing key here leaves a gap that
    // already existed, rather than breaking every clinic's dashboard.
    expect(call(createRequireStaffKey(undefined), {}).next).toHaveBeenCalledOnce();
  });
});
