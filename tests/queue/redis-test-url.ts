/**
 * The guard shared by the opt-in real-Redis suites: TEST_REDIS_URL must point at a throwaway
 * local Redis, because the suites obliterate their queue. It accepts a URL only when ALL of
 * these hold:
 *  - a redis: or rediss: URL on a loopback host;
 *  - an explicit port that is not Redis's default 6379, so a developer's everyday Redis is
 *    never the target by accident;
 *  - an explicit, non-zero database index (index 0 is where everything else lives), so
 *    "redis://127.0.0.1:6392" without a path is refused too.
 * Anything else, including a malformed URL, is "not safe" and the suite skips.
 */
export const isSafeTestRedisUrl = (value: string | undefined): value is string => {
  if (!value) return false;

  try {
    const parsed = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
    const dbIndex = parsed.pathname.replace(/^\//, "");

    return (
      ["redis:", "rediss:"].includes(parsed.protocol) &&
      loopback &&
      parsed.port !== "" &&
      parsed.port !== "6379" &&
      /^\d+$/.test(dbIndex) &&
      Number(dbIndex) !== 0
    );
  } catch {
    return false;
  }
};
