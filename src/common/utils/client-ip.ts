import type { Request } from "express";

/**
 * The caller's address, for rate-limit keys.
 *
 * Only CF-Connecting-IP is trusted, because Cloudflare overwrites it on every request it
 * proxies and it therefore cannot be spoofed through Cloudflare. X-Forwarded-For is
 * deliberately ignored: Railway exposes a *.up.railway.app hostname that bypasses
 * Cloudflare entirely, so an attacker reaching the origin directly could forge XFF and
 * mint an unlimited supply of rate-limit buckets.
 *
 * Never returns undefined, so a limiter key is always well formed. Note the fallback
 * collapses to the proxy's address when the edge header is absent, which is why
 * requireEdge exists.
 */
export const clientIp = (req: Request): string => {
  const edge = req.headers["cf-connecting-ip"];

  if (typeof edge === "string" && edge.length > 0) {
    return edge;
  }

  return req.socket.remoteAddress ?? "unknown";
};
