import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NAMES = [
  "BUNNY_STORAGE_ZONE",
  "BUNNY_STORAGE_ENDPOINT",
  "BUNNY_STORAGE_ACCESS_KEY",
  "BUNNY_PUBLIC_BASE_URL"
] as const;

const saved: Record<string, string | undefined> = {};

// config/env.ts parses at import time, so each case sets the variables and re-imports it.
// Empty strings stand for "unset": dotenv never overrides a variable that is already
// present, so this stays independent of a developer's own .env.
const loadConfig = async (values: Partial<Record<(typeof NAMES)[number], string>>) => {
  for (const name of NAMES) process.env[name] = values[name] ?? "";

  vi.resetModules();

  return (await import("../../src/config/env")).config;
};

beforeEach(() => {
  for (const name of NAMES) saved[name] = process.env[name];
});

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }

  vi.resetModules();
});

describe("Bunny image storage configuration", () => {
  it("boots with none of the variables set, and the endpoint defaults to Frankfurt", async () => {
    const config = await loadConfig({});

    expect(config.BUNNY_STORAGE_ZONE).toBeUndefined();
    expect(config.BUNNY_STORAGE_ACCESS_KEY).toBeUndefined();
    expect(config.BUNNY_PUBLIC_BASE_URL).toBeUndefined();
    expect(config.BUNNY_STORAGE_ENDPOINT).toBe("https://storage.bunnycdn.com");
  });

  it("reads the four variables and drops a trailing slash", async () => {
    const config = await loadConfig({
      BUNNY_STORAGE_ZONE: "my-zone",
      BUNNY_STORAGE_ENDPOINT: "https://ny.storage.bunnycdn.com/",
      BUNNY_STORAGE_ACCESS_KEY: "write-password",
      BUNNY_PUBLIC_BASE_URL: "https://cdn.example.com/"
    });

    expect(config.BUNNY_STORAGE_ZONE).toBe("my-zone");
    expect(config.BUNNY_STORAGE_ENDPOINT).toBe("https://ny.storage.bunnycdn.com");
    expect(config.BUNNY_PUBLIC_BASE_URL).toBe("https://cdn.example.com");
  });

  it("refuses a public base URL that is not https", async () => {
    await expect(loadConfig({ BUNNY_PUBLIC_BASE_URL: "http://cdn.example.com" })).rejects.toThrow(
      /BUNNY_PUBLIC_BASE_URL/
    );
  });

  it("refuses a storage endpoint that is not https", async () => {
    await expect(
      loadConfig({ BUNNY_STORAGE_ENDPOINT: "http://storage.bunnycdn.com" })
    ).rejects.toThrow(/BUNNY_STORAGE_ENDPOINT/);
  });

  it("refuses a zone name that could change the request path", async () => {
    await expect(loadConfig({ BUNNY_STORAGE_ZONE: "a/b" })).rejects.toThrow(/BUNNY_STORAGE_ZONE/);
  });
});
