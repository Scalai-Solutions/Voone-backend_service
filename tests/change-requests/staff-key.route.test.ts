import express from "express";
import { afterAll, describe, expect, it } from "vitest";

import { errorHandler } from "../../src/common/middleware/error-handler";
import type { ChangeRequestService } from "../../src/modules/change-requests/service";
import { createChangeRequestsRouter } from "../../src/routes/v1/change-requests.route";

/**
 * The staff key guard on the change-requests router. The service is never reached on a
 * refusal, and a request that gets past the guard fails later on its fake, so a status other
 * than 403/503 proves the guard let it through.
 */
const build = (options: { staffKey?: string; failClosed: boolean }) => {
  const app = express();

  app.use(express.json());
  app.use(
    "/api/v1",
    createChangeRequestsRouter({
      service: {} as ChangeRequestService,
      findClinic: async () => ({ id: "c" }),
      clinicExists: async () => true,
      ...options
    })
  );
  app.use(errorHandler);

  const server = app.listen(0);

  servers.push(server);

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return async (method: string, path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-actor": "someone@voone.test",
        // Each side needs its own role to get past the role gate, which is not under test here.
        "x-actor-role": path.startsWith("/admin") ? "voone_admin" : "owner",
        ...headers
      },
      body: method === "GET" ? undefined : "{}"
    });

    return response.status;
  };
};

const servers: Array<ReturnType<typeof express.application.listen>> = [];

afterAll(() => {
  for (const server of servers) server.close();
});

const ROUTES: Array<[string, string]> = [
  ["POST", "/clinics/aurea/change-requests"],
  ["GET", "/clinics/aurea/change-requests"],
  ["GET", "/clinics/aurea/change-requests/x"],
  ["POST", "/clinics/aurea/change-requests/x/messages"],
  ["POST", "/clinics/aurea/change-requests/x/reopen"],
  ["GET", "/admin/change-requests"],
  ["GET", "/admin/clinics/c/change-requests"],
  ["GET", "/admin/change-requests/x"],
  ["PATCH", "/admin/change-requests/x/status"],
  ["POST", "/admin/change-requests/x/apply"],
  ["POST", "/admin/change-requests/x/draft"],
  ["POST", "/admin/clinics/c/onboarding/programs/p/resolve-tickets"],
  ["POST", "/admin/change-requests/x/messages"]
];

describe("staff key on the change-requests routes", () => {
  it("fails closed in production when no key is configured: every route is a 503", async () => {
    const call = build({ staffKey: undefined, failClosed: true });

    for (const [method, path] of ROUTES) expect(await call(method, path)).toBe(503);
  });

  it("outside production, with no key, lets requests through as today", async () => {
    const call = build({ staffKey: undefined, failClosed: false });

    for (const [method, path] of ROUTES) {
      const status = await call(method, path);

      expect(status).not.toBe(503);
      expect(status).not.toBe(403);
    }
  });

  it("with a key configured, refuses a missing or wrong key and accepts the right one", async () => {
    for (const failClosed of [true, false]) {
      const call = build({ staffKey: "s3cret", failClosed });

      for (const [method, path] of ROUTES) {
        expect(await call(method, path)).toBe(403);
        expect(await call(method, path, { "x-voone-staff-key": "nope" })).toBe(403);
        expect([403, 503]).not.toContain(
          await call(method, path, { "x-voone-staff-key": "s3cret" })
        );
      }
    }
  });
});
