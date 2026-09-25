import express, { type Express } from "express";
import { describe, expect, it } from "vitest";

import { errorHandler } from "../../src/common/middleware/error-handler";
import type { DashboardService } from "../../src/modules/dashboard/dashboard.service";
import { createDashboardRouter } from "../../src/routes/v1/dashboard.route";

const CLINIC = "clinic-1";

const overview = {
  activeMembers: 42,
  pointsIssuedThisMonth: 3200,
  walletAdds: 17,
  recentActivity: [{ id: "t1", label: "Hydrafacial", date: "2026-09-26" }]
};

const wallet = {
  appleCertificateExpiresAt: "2027-10-24T06:43:21.000Z",
  appleEnabled: true,
  googlePublishingStatus: "demo" as const,
  recentErrors: [{ provider: "google" as const, count: 2, label: "Sincronización fallida" }]
};

const buildApp = () => {
  const calls: unknown[] = [];

  const dashboard = {
    clinicOverview: async (clinicId: string) => {
      calls.push({ clinicOverview: clinicId });

      return overview;
    },
    platformOverview: async () => ({ totalClinics: 3, totalMembers: 120, wallet }),
    walletInfrastructure: async () => wallet
  } as unknown as DashboardService;

  const app = express();
  app.use("/api/v1", createDashboardRouter({ dashboard }));
  app.use(errorHandler);

  return { app, calls };
};

const get = async (app: Express, path: string) => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
};

describe("GET /dashboard/overview", () => {
  it("requires clinicId, so one clinic cannot read another's figures", async () => {
    const { app } = buildApp();

    const res = await get(app, "/api/v1/dashboard/overview");

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("clinicId");
  });

  it("returns the clinic's numbers", async () => {
    const { app, calls } = buildApp();

    const res = await get(app, `/api/v1/dashboard/overview?clinicId=${CLINIC}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(overview);
    expect(calls[0]).toEqual({ clinicOverview: CLINIC });
  });
});

describe("GET /admin/overview", () => {
  it("is platform-wide and takes no clinic", async () => {
    // Voone's own view across every clinic. The staff key proves the request came from
    // the Voone app, not that the caller is an administrator — that check lives in the
    // frontend's route handler, same as the existing /admin/clinics routes.
    const { app } = buildApp();

    const res = await get(app, "/api/v1/admin/overview");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalClinics: 3, totalMembers: 120, wallet });
  });
});

describe("GET /admin/wallet", () => {
  it("reports the certificate expiry and both providers", async () => {
    const { app } = buildApp();

    const res = await get(app, "/api/v1/admin/wallet");

    expect(res.status).toBe(200);
    expect(res.body.appleCertificateExpiresAt).toBe("2027-10-24T06:43:21.000Z");
    expect(res.body.appleEnabled).toBe(true);
    expect(res.body.googlePublishingStatus).toBe("demo");
    expect(res.body.recentErrors).toHaveLength(1);
  });
});
