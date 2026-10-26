import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { makeImage } from "./image-fixtures";

// The whole app with Bunny fully configured but no staff key: the upload routes must not
// become open to anyone who can reach the API, unlike the other staff routes.
vi.mock("../../src/config/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/config/env")>();

  return {
    ...original,
    config: {
      ...original.config,
      STAFF_API_KEY: undefined,
      BUNNY_STORAGE_ZONE: "zone",
      BUNNY_STORAGE_ACCESS_KEY: "not-a-real-key",
      BUNNY_PUBLIC_BASE_URL: "https://cdn.example.test"
    }
  };
});

const { buildApp } = await import("../../src/app");

describe("the app with no staff key configured", () => {
  it("refuses an upload with 503 and never calls Bunny", async () => {
    const realFetch = globalThis.fetch;
    const outbound: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);

      if (!url.startsWith("http://127.0.0.1")) outbound.push(url);

      return realFetch(input, init);
    });

    const server = buildApp().listen(0);

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/admin/images?kind=logo`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: new Uint8Array(await makeImage("png"))
      });

      expect(response.status).toBe(503);
      expect(outbound).toEqual([]);
    } finally {
      server.close();
    }
  });
});
