import type { AddressInfo } from "node:net";

import express from "express";
import { describe, expect, it, vi } from "vitest";

const getRefreshStatus = vi.hoisted(() => vi.fn());

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

describe("GET /templates/refresh-status", () => {
  it("answers for the clinic in x-clinic-id, without a staff key, ahead of /templates/:templateId", async () => {
    const status = {
      eligible: 3,
      lastChange: { at: "2026-10-26T10:00:00.000Z", by: null, cardsAtSave: 3 },
      syncedSince: 1,
      failedSince: 0
    };

    getRefreshStatus.mockResolvedValue(status);

    const response = await get("/templates/refresh-status", {
      "x-clinic-id": "00000000-0000-4000-8000-000000000001"
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(status);
    expect(getRefreshStatus).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
  });

  it("is a 400 when no clinic is named", async () => {
    const response = await get("/templates/refresh-status");

    expect(response.status).toBe(400);
  });
});
