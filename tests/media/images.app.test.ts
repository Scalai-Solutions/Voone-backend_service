import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { makeImage } from "./image-fixtures";

const STAFF_KEY = vi.hoisted(() => "test-staff-key");

// The whole app, with the Bunny variables unset and a staff key configured.
vi.mock("../../src/config/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/config/env")>();

  return {
    ...original,
    config: {
      ...original.config,
      STAFF_API_KEY: STAFF_KEY,
      BUNNY_STORAGE_ZONE: undefined,
      BUNNY_STORAGE_ACCESS_KEY: undefined,
      BUNNY_PUBLIC_BASE_URL: undefined
    }
  };
});

const { buildApp } = await import("../../src/app");

const call = async (path: string, init: RequestInit = {}) => {
  const server = buildApp().listen(0);

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);

    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
};

describe("the app without any Bunny configuration", () => {
  it("boots and serves the rest of the API", async () => {
    const res = await call("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("answers the admin upload with 503 and the Spanish message, behind the global JSON parser", async () => {
    const res = await call("/api/v1/admin/images?kind=logo", {
      method: "POST",
      headers: { "content-type": "image/png", "x-voone-staff-key": STAFF_KEY },
      body: new Uint8Array(await makeImage("png"))
    });

    expect(res.status).toBe(503);
    expect(res.body.message).toBe("La subida de imágenes no está configurada.");
  });

  it("still asks for the staff key first", async () => {
    const res = await call("/api/v1/admin/images?kind=logo", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(await makeImage("png"))
    });

    expect(res.status).toBe(403);
  });
});
