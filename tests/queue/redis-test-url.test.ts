import { describe, expect, it } from "vitest";

import { isSafeTestRedisUrl } from "./redis-test-url";

describe("isSafeTestRedisUrl", () => {
  it.each([
    "redis://127.0.0.1:6392/1",
    "redis://localhost:6392/3",
    "rediss://[::1]:6392/2",
    "redis://:password@127.0.0.1:6392/1"
  ])("accepts %s", (value) => {
    expect(isSafeTestRedisUrl(value)).toBe(true);
  });

  it.each([
    ["the default port", "redis://127.0.0.1:6379/1"],
    ["no port", "redis://127.0.0.1/1"],
    ["a malformed URL", "not a url"],
    ["a non-loopback host", "redis://redis.example.com:6392/1"],
    ["database 0", "redis://127.0.0.1:6392/0"],
    ["no database path", "redis://127.0.0.1:6392"],
    ["an empty database path", "redis://127.0.0.1:6392/"],
    ["a non-numeric database", "redis://127.0.0.1:6392/abc"],
    ["another protocol", "http://127.0.0.1:6392/1"],
    ["undefined", undefined],
    ["an empty string", ""]
  ])("rejects %s", (_name, value) => {
    expect(isSafeTestRedisUrl(value)).toBe(false);
  });
});
