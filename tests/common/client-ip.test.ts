import type { Request } from "express";
import { describe, expect, it } from "vitest";

import { clientIp, isEdgeVerified, markEdgeVerified } from "../../src/common/utils/client-ip";

/**
 * These assert a trust boundary, not a parser. The question each one answers is "whose
 * word are we taking for this address?", because the answer decides whether the sign-up
 * rate limiter can be bypassed by setting a header.
 */
/** `null` means the socket has no address at all; omitted means a normal Railway hop. */
const request = (
  headers: Record<string, string | string[]>,
  remoteAddress: string | null = "100.64.0.7"
): Request =>
  ({
    headers,
    socket: { remoteAddress: remoteAddress ?? undefined }
  }) as unknown as Request;

describe("clientIp, on a request that did NOT prove it came through the edge", () => {
  it("ignores CF-Connecting-IP, because anyone can set it on a direct request", () => {
    // The regression this exists for: the origin is reachable at *.up.railway.app and at
    // api.voone.ai, neither proxied. Trusting this header handed every caller an
    // unlimited supply of rate-limit buckets.
    const ip = clientIp(request({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }));

    expect(ip).toBe("9.9.9.9");
  });

  it("takes the RIGHTMOST forwarded entry, which is the one our proxy observed", () => {
    // The left of the chain is whatever the client sent. Taking it is the classic bug.
    const ip = clientIp(request({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 203.0.113.9" }));

    expect(ip).toBe("203.0.113.9");
  });

  it("is not fooled by a forged chain, however long", () => {
    const forged = Array.from({ length: 50 }, (_, i) => `1.1.1.${i}`).join(", ");
    const ip = clientIp(request({ "x-forwarded-for": `${forged}, 203.0.113.9` }));

    expect(ip).toBe("203.0.113.9");
  });

  it("works when a proxy replaces the header outright rather than appending", () => {
    // Then the chain is one entry and both ends agree, so rightmost is still right.
    expect(clientIp(request({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("walks past our own infrastructure to the last real address", () => {
    const ip = clientIp(request({ "x-forwarded-for": "203.0.113.9, 100.64.3.2, 10.0.0.1" }));

    expect(ip).toBe("203.0.113.9");
  });

  it("falls back to the socket when there is no usable chain", () => {
    expect(clientIp(request({}, "198.51.100.4"))).toBe("198.51.100.4");
  });

  it("never returns undefined, so a limiter key is always well formed", () => {
    expect(clientIp(request({}, null))).toBe("unknown");
  });

  it("handles a repeated header, which Node gives us as an array", () => {
    const ip = clientIp(request({ "x-forwarded-for": ["1.1.1.1", "203.0.113.9"] }));

    expect(ip).toBe("203.0.113.9");
  });

  it("tolerates whitespace and empty entries rather than keying on a blank", () => {
    expect(clientIp(request({ "x-forwarded-for": " 203.0.113.9 ,, " }))).toBe("203.0.113.9");
  });
});

describe("clientIp, on a request the edge verified", () => {
  it("believes CF-Connecting-IP, because a hop that knows the secret set it", () => {
    const req = request({ "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "9.9.9.9" });
    markEdgeVerified(req);

    expect(clientIp(req)).toBe("203.0.113.5");
  });

  it("still falls through when the edge header is missing", () => {
    const req = request({ "x-forwarded-for": "203.0.113.9" });
    markEdgeVerified(req);

    expect(clientIp(req)).toBe("203.0.113.9");
  });
});

describe("edge verification marking", () => {
  it("is false until something marks it", () => {
    expect(isEdgeVerified(request({}))).toBe(false);
  });

  it("cannot be forged by sending a header", () => {
    // The flag is a symbol on the request object, so no header name can reach it.
    const req = request({
      edgeverified: "true",
      "x-voone-edge-verified": "true",
      "cf-connecting-ip": "1.2.3.4"
    });

    expect(isEdgeVerified(req)).toBe(false);
    expect(clientIp(req)).not.toBe("1.2.3.4");
  });
});
