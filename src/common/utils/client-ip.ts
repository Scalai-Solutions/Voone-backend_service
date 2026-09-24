import type { Request } from "express";

/**
 * Set by requireEdge once a request has PROVEN it came through the edge. A symbol rather
 * than a header or a string property: nothing a client sends can collide with it.
 */
const EDGE_VERIFIED = Symbol.for("voone.edgeVerified");

export const markEdgeVerified = (req: Request): void => {
  (req as Request & { [EDGE_VERIFIED]?: boolean })[EDGE_VERIFIED] = true;
};

export const isEdgeVerified = (req: Request): boolean =>
  (req as Request & { [EDGE_VERIFIED]?: boolean })[EDGE_VERIFIED] === true;

/**
 * Railway's own proxies sit in 100.64.0.0/10. Real clients never appear from that range:
 * it is carrier-grade NAT space and not routable across the internet, so a mobile user
 * behind CGNAT still reaches us from their carrier's public address.
 */
const isInfrastructureAddress = (ip: string): boolean => {
  const match = /^(\d+)\.(\d+)\./.exec(ip);

  if (!match) return false;

  const first = Number(match[1]);
  const second = Number(match[2]);

  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 127) return true;
  if (first === 10) return true;

  return false;
};

/**
 * The caller's address, for rate-limit keys.
 *
 * The rule is that a header is only as trustworthy as the hop that set it, and the only
 * hop we can identify is the one that proved itself with the edge secret.
 *
 * CF-Connecting-IP is therefore trusted ONLY on a request requireEdge has verified. It
 * used to be trusted unconditionally, on the reasoning that Cloudflare overwrites it and
 * so it cannot be forged *through Cloudflare* — which was true, and irrelevant: nothing
 * was proxied, so anyone could set that header on a direct request to the origin and mint
 * a fresh rate-limit bucket per request. The limiter was bypassable in one line of curl.
 *
 * Otherwise the RIGHTMOST X-Forwarded-For entry is used. Rightmost, never leftmost: in an
 * appending chain the left end is whatever the client sent and the right end is what the
 * proxy in front of us observed. Taking the leftmost entry is the classic version of this
 * bug. Rightmost is also correct if a proxy replaces the header outright, since then the
 * chain is one entry and both ends agree.
 *
 * Never returns undefined, so a limiter key is always well formed.
 */
export const clientIp = (req: Request): string => {
  if (isEdgeVerified(req)) {
    const edge = req.headers["cf-connecting-ip"];

    if (typeof edge === "string" && edge.length > 0) {
      return edge.trim();
    }
  }

  const forwarded = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // Walk right to left past our own infrastructure to the last address a trusted hop
  // actually observed.
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (!isInfrastructureAddress(chain[i])) {
      return chain[i];
    }
  }

  return req.socket.remoteAddress ?? "unknown";
};
