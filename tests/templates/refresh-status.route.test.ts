import type { AddressInfo } from "node:net";

import express from "express";
import { describe, expect, it, vi } from "vitest";

const getRefreshStatus = vi.hoisted(() => vi.fn());
const STAFF_KEY = vi.hoisted(() => "test-staff-key");

// The staff gate is a no-op when no key is configured, so configure one.
vi.mock("../../src/config/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/config/env")>();

  return { ...original, config: { ...original.config, STAFF_API_KEY: STAFF_KEY } };
});

vi.mock("../../src/modules/wallet-refresh/refresh-status", () => ({ getRefreshStatus }));

const { templatesRouter } = await import("../../src/routes/v1/templates.route");

const app = express().use(express.json()).use(templatesRouter);

/** Minimal fetch against the app, matching tests/points: no supertest dependency. */
const get = async (path: string, headers: Record<string, string> = {}) => {
  const server = app.listen(0);

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });

    return { status: response.status, body: (await response.json()) as unknown };
  } finally {
    server.close();
  }
};

const CLINIC = "00000000-0000-4000-8000-000000000001";

describe("GET /templates/refresh-status", () => {
  it("answers staff for the clinic in x-clinic-id, ahead of /templates/:templateId", async () => {
    const status = {
      eligible: 3,
      lastChange: { at: "2026-10-26T10:00:00.000Z", by: "staff@clinic.test", cardsAtSave: 3 },
      syncedSince: 1,
      failedSince: 0
    };

    getRefreshStatus.mockResolvedValue(status);

    const response = await get("/templates/refresh-status", {
      "x-clinic-id": CLINIC,
      "x-voone-staff-key": STAFF_KEY
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(status);
    expect(getRefreshStatus).toHaveBeenCalledWith(CLINIC);
  });

  it("refuses a caller without the staff key, because it carries a staff email", async () => {
    getRefreshStatus.mockClear();

    const response = await get("/templates/refresh-status", { "x-clinic-id": CLINIC });

    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain("@");
    expect(getRefreshStatus).not.toHaveBeenCalled();
  });

  it("refuses a wrong staff key", async () => {
    getRefreshStatus.mockClear();

    const response = await get("/templates/refresh-status", {
      "x-clinic-id": CLINIC,
      "x-voone-staff-key": "not-the-key"
    });

    expect(response.status).toBe(403);
    expect(getRefreshStatus).not.toHaveBeenCalled();
  });
});
