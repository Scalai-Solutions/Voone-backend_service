import { isIP } from "node:net";

/**
 * Only public https hosts. The URL is typed by a clinic, so without this it could point the
 * server at its own network. Resolving the name is not done here, so a hostname that resolves
 * to a private address is not caught; the fetch also refuses redirects, which closes the
 * common route to one.
 */
export const isPublicHttpsUrl = (raw: string): boolean => {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal"))
    return false;
  if (!host.includes(".") && isIP(host) === 0) return false;

  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);

    return !(
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (isIP(host) === 6) return false;

  return true;
};
