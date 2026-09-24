import express, { type Express } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createApplePassesRouter,
  type ApplePassesRouterDeps
} from "../../src/routes/v1/apple-passes.route";
import type { LoyaltyCard } from "../../src/wallet/engine/loyalty-card";
import type { PassRecord } from "../../src/wallet/engine/pass-device.repository";
import { aureaGoldPass } from "../fixtures/loyalty-card.fixture";

const SERIAL = aureaGoldPass.serialNumber;
const PASS_TYPE = "pass.com.voone.loyalty";
const DEVICE = "device-library-id-1";
const TOKEN = "the-per-pass-bearer-token";

/**
 * Exercised over a real Express app rather than by calling handlers directly, because
 * what this suite is actually asserting is the HTTP contract — status codes, headers and
 * the 204/200 distinction — none of which a direct call would prove.
 */
const appWith = (overrides: Partial<Record<string, unknown>> = {}) => {
  const saveRegistration = vi.fn(async () => ({ created: true }));
  const removeRegistration = vi.fn(async () => true);
  const serialsUpdatedSince = vi.fn(async () => ({
    serialNumbers: [] as string[],
    lastUpdated: null as Date | null
  }));
  const passRecordFor = vi.fn(async (): Promise<PassRecord | null> => ({
    memberId: aureaGoldPass.memberId,
    lastUpdated: new Date("2026-09-20T10:00:00.000Z")
  }));
  const authenticate = vi.fn(async (_serial: string, token: string) => token === TOKEN);
  const buildPassFor = vi.fn(async (card: LoyaltyCard) => ({
    buffer: Buffer.from(`signed:${card.serialNumber}`),
    fileName: `${card.serialNumber}.pkpass`,
    contentType: "application/vnd.apple.pkpass" as const,
    serialNumber: card.serialNumber
  }));
  const assemble = vi.fn(async () => aureaGoldPass);

  const devices = {
    saveRegistration,
    removeRegistration,
    serialsUpdatedSince,
    passRecordFor,
    pushTokensFor: vi.fn(async () => []),
    authenticationTokenFor: vi.fn(async () => TOKEN),
    setAuthenticationToken: vi.fn(async () => {}),
    ...overrides
  };

  const deps = {
    provider: { authenticate, buildPassFor },
    devices,
    assembler: { assemble },
    now: () => new Date("2026-09-21T12:00:00.000Z")
  } as unknown as ApplePassesRouterDeps;

  const app: Express = express();
  app.use(express.json());
  app.use("/api/v1", createApplePassesRouter(deps));

  return {
    app,
    saveRegistration,
    removeRegistration,
    serialsUpdatedSince,
    passRecordFor,
    authenticate,
    buildPassFor,
    assemble
  };
};

/** Minimal fetch against the app, so the suite needs no supertest dependency. */
const call = async (
  app: Express,
  method: string,
  path: string,
  init: { auth?: string; body?: unknown; headers?: Record<string, string> } = {}
) => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const headers: Record<string, string> = { ...init.headers };

    if (init.auth) headers.Authorization = init.auth;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });

    return {
      status: response.status,
      headers: response.headers,
      text: await response.text()
    };
  } finally {
    server.close();
  }
};

const registrationPath = `/api/v1/devices/${DEVICE}/registrations/${PASS_TYPE}/${SERIAL}`;
const listPath = `/api/v1/devices/${DEVICE}/registrations/${PASS_TYPE}`;
const passPath = `/api/v1/passes/${PASS_TYPE}/${SERIAL}`;
const auth = `ApplePass ${TOKEN}`;

describe("Apple pass web service", () => {
  let ctx: ReturnType<typeof appWith>;

  beforeEach(() => {
    ctx = appWith();
  });

  describe("authentication", () => {
    it("refuses a request with no Authorization header", async () => {
      const res = await call(ctx.app, "POST", registrationPath, { body: { pushToken: "p" } });

      expect(res.status).toBe(401);
      expect(ctx.saveRegistration).not.toHaveBeenCalled();
    });

    it("refuses a wrong token", async () => {
      const res = await call(ctx.app, "POST", registrationPath, {
        auth: "ApplePass not-the-token",
        body: { pushToken: "p" }
      });

      expect(res.status).toBe(401);
    });

    it("refuses a header that is not the ApplePass scheme", async () => {
      const res = await call(ctx.app, "POST", registrationPath, {
        auth: `Bearer ${TOKEN}`,
        body: { pushToken: "p" }
      });

      expect(res.status).toBe(401);
    });

    it("accepts the scheme case-insensitively, as devices have been known to vary it", async () => {
      const res = await call(ctx.app, "POST", registrationPath, {
        auth: `applepass ${TOKEN}`,
        body: { pushToken: "p" }
      });

      expect(res.status).toBe(201);
    });
  });

  describe("registering a device", () => {
    it("answers 201 for a registration that is new", async () => {
      const res = await call(ctx.app, "POST", registrationPath, {
        auth,
        body: { pushToken: "push-1" }
      });

      expect(res.status).toBe(201);
      expect(ctx.saveRegistration).toHaveBeenCalledWith({
        deviceLibraryIdentifier: DEVICE,
        passTypeIdentifier: PASS_TYPE,
        serialNumber: SERIAL,
        pushToken: "push-1"
      });
    });

    it("answers 200 when the device already had it, which is how a rotated token reads", async () => {
      const already = appWith({ saveRegistration: vi.fn(async () => ({ created: false })) });

      const res = await call(already.app, "POST", registrationPath, {
        auth,
        body: { pushToken: "push-2" }
      });

      expect(res.status).toBe(200);
    });

    it("rejects a body with no push token rather than storing an empty one", async () => {
      const res = await call(ctx.app, "POST", registrationPath, { auth, body: {} });

      expect(res.status).toBe(400);
      expect(ctx.saveRegistration).not.toHaveBeenCalled();
    });
  });

  describe("unregistering a device", () => {
    it("answers 200 and removes the registration", async () => {
      const res = await call(ctx.app, "DELETE", registrationPath, { auth });

      expect(res.status).toBe(200);
      expect(ctx.removeRegistration).toHaveBeenCalledWith(DEVICE, PASS_TYPE, SERIAL);
    });

    it("still answers 200 when there was nothing to remove", async () => {
      const none = appWith({ removeRegistration: vi.fn(async () => false) });

      const res = await call(none.app, "DELETE", registrationPath, { auth });

      // The device's intent is "stop telling me". A 404 would make it retry something
      // that is already true.
      expect(res.status).toBe(200);
    });
  });

  describe("listing updated serials", () => {
    it("answers 204 when nothing changed, so devices back off", async () => {
      const res = await call(ctx.app, "GET", listPath);

      expect(res.status).toBe(204);
      expect(res.text).toBe("");
    });

    it("answers 200 with the serials and a tag when something did", async () => {
      const changed = appWith({
        serialsUpdatedSince: vi.fn(async () => ({
          serialNumbers: [SERIAL],
          lastUpdated: new Date("2026-09-21T09:00:00.000Z")
        }))
      });

      const res = await call(changed.app, "GET", listPath);

      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toEqual({
        serialNumbers: [SERIAL],
        lastUpdated: String(Math.floor(Date.parse("2026-09-21T09:00:00.000Z") / 1000))
      });
    });

    it("needs no pass token — the call is scoped to a device, not to one pass", async () => {
      const res = await call(ctx.app, "GET", listPath);

      expect(res.status).toBe(204);
      expect(ctx.authenticate).not.toHaveBeenCalled();
    });

    it("passes the device's tag through as a date", async () => {
      await call(ctx.app, "GET", `${listPath}?passesUpdatedSince=1758358800`);

      expect(ctx.serialsUpdatedSince).toHaveBeenCalledWith(
        DEVICE,
        PASS_TYPE,
        new Date(1758358800 * 1000)
      );
    });

    it("ignores an unparseable tag rather than filtering on Invalid Date", async () => {
      await call(ctx.app, "GET", `${listPath}?passesUpdatedSince=not-a-number`);

      expect(ctx.serialsUpdatedSince).toHaveBeenCalledWith(DEVICE, PASS_TYPE, undefined);
    });
  });

  describe("serving a pass", () => {
    it("returns the signed file with the pass content type", async () => {
      const res = await call(ctx.app, "GET", passPath, { auth });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/vnd.apple.pkpass");
      expect(res.text).toBe(`signed:${SERIAL}`);
    });

    it("reports the pass's own modification time, not the clock", async () => {
      const res = await call(ctx.app, "GET", passPath, { auth });

      expect(res.headers.get("last-modified")).toBe(
        new Date("2026-09-20T10:00:00.000Z").toUTCString()
      );
    });

    it("answers 304 when the device already has this version", async () => {
      const res = await call(ctx.app, "GET", passPath, {
        auth,
        headers: { "If-Modified-Since": new Date("2026-09-20T10:00:00.000Z").toUTCString() }
      });

      expect(res.status).toBe(304);
      // The whole point: an unchanged pass is never rebuilt or re-signed.
      expect(ctx.buildPassFor).not.toHaveBeenCalled();
    });

    it("rebuilds when the device's copy is older", async () => {
      const res = await call(ctx.app, "GET", passPath, {
        auth,
        headers: { "If-Modified-Since": new Date("2026-09-19T10:00:00.000Z").toUTCString() }
      });

      expect(res.status).toBe(200);
      expect(ctx.buildPassFor).toHaveBeenCalled();
    });

    it("answers 404 for a serial we no longer hold, not 401", async () => {
      const gone = appWith({ passRecordFor: vi.fn(async () => null) });

      const res = await call(gone.app, "GET", passPath, { auth });

      // The token was right; the pass is simply not ours to serve any more.
      expect(res.status).toBe(404);
    });
  });

  describe("device logs", () => {
    it("accepts them, because a device that cannot log must not think we are down", async () => {
      const res = await call(ctx.app, "POST", "/api/v1/log", {
        body: { logs: ["could not validate pass"] }
      });

      expect(res.status).toBe(200);
    });

    it("accepts a malformed body too", async () => {
      const res = await call(ctx.app, "POST", "/api/v1/log", { body: {} });

      expect(res.status).toBe(200);
    });
  });
});
