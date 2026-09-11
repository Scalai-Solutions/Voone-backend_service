import type { Request } from "express";
import { describe, expect, it } from "vitest";

import { clientIp } from "../../src/common/utils/client-ip";

const request = (headers: Record<string, string>, remoteAddress?: string) =>
  ({ headers, socket: { remoteAddress } }) as unknown as Request;

describe("clientIp", () => {
  it("prefers CF-Connecting-IP, which Cloudflare overwrites on every proxied request", () => {
    expect(clientIp(request({ "cf-connecting-ip": "203.0.113.7" }, "10.0.0.1"))).toBe(
      "203.0.113.7"
    );
  });

  it("ignores X-Forwarded-For, which a direct origin hit can spoof freely", () => {
    // Railway exposes a *.up.railway.app hostname that bypasses Cloudflare. Trusting
    // XFF there would hand an attacker an unlimited supply of rate-limit buckets.
    expect(clientIp(request({ "x-forwarded-for": "1.2.3.4" }, "10.0.0.1"))).toBe("10.0.0.1");
  });

  it("falls back to the socket address when no edge header is present", () => {
    expect(clientIp(request({}, "10.0.0.1"))).toBe("10.0.0.1");
  });

  it("never returns undefined, so a rate-limit key is always well formed", () => {
    expect(clientIp(request({}))).toBe("unknown");
    expect(clientIp(request({ "cf-connecting-ip": "" }))).toBe("unknown");
  });
});
