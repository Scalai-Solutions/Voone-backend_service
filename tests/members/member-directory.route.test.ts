import express, { type Express } from "express";
import { describe, expect, it } from "vitest";

import { errorHandler } from "../../src/common/middleware/error-handler";
import { MemberNotFoundError } from "../../src/common/errors/membership.errors";
import type { MemberDirectoryService } from "../../src/modules/members/member-directory.service";
import { createMemberDirectoryRouter } from "../../src/routes/v1/member-directory.route";

const CLINIC = "clinic-1";

const summary = {
  id: "m-1",
  name: "Verónica Navarro",
  identity: "+34612345678",
  email: null,
  templateId: "tpl-1",
  templateName: "AURÉA Clinic Club",
  points: 500,
  tier: "",
  walletStatus: { apple: "added", google: "unavailable" },
  history: [{ id: "h1", label: "Hydrafacial", points: 120, date: "2026-09-04" }]
};

const buildApp = () => {
  const calls: unknown[] = [];

  const directory = {
    list: async (options: unknown) => {
      calls.push(options);

      return [summary];
    },
    get: async (memberId: string) => {
      calls.push({ get: memberId });

      if (memberId !== "m-1") throw new MemberNotFoundError(memberId);

      return summary;
    }
  } as unknown as MemberDirectoryService;

  const app = express();
  app.use(
    "/api/v1",
    createMemberDirectoryRouter({
      directory,
      clinicIdForSlug: async (slug) => (slug === "aurea" ? CLINIC : null),
      treatmentsFor: async (clinicId) => {
        calls.push({ treatmentsFor: clinicId });

        return [{ id: "t-1", name: "Hydrafacial", priceEuro: 120, points: 120 }];
      }
    })
  );
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

describe("GET /members", () => {
  it("requires clinicId, because the staff key cannot identify a clinic", async () => {
    // The decision this protects: the dashboard calls /v1/members with no clinic at all.
    // A backend that obliged would show every clinic the others' member lists — names and
    // phone numbers of people attending a named aesthetic clinic.
    const { app } = buildApp();

    const res = await get(app, "/api/v1/members");

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("clinicId");
  });

  it("returns the clinic's members", async () => {
    const { app } = buildApp();

    const res = await get(app, `/api/v1/members?clinicId=${CLINIC}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([summary]);
  });

  it("passes the search term through", async () => {
    const { app, calls } = buildApp();

    await get(app, `/api/v1/members?clinicId=${CLINIC}&q=nav`);

    expect(calls[0]).toMatchObject({ clinicId: CLINIC, query: "nav" });
  });

  it("defaults the page size rather than returning everything", async () => {
    const { app, calls } = buildApp();

    await get(app, `/api/v1/members?clinicId=${CLINIC}`);

    expect(calls[0]).toMatchObject({ limit: 50, offset: 0 });
  });

  it("refuses an unbounded page size", async () => {
    const { app } = buildApp();

    expect((await get(app, `/api/v1/members?clinicId=${CLINIC}&limit=100000`)).status).toBe(422);
  });

  it("refuses a negative offset", async () => {
    const { app } = buildApp();

    expect((await get(app, `/api/v1/members?clinicId=${CLINIC}&offset=-1`)).status).toBe(422);
  });
});

describe("GET /members/:id", () => {
  it("returns the member", async () => {
    const { app } = buildApp();

    const res = await get(app, "/api/v1/members/m-1");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("m-1");
  });

  it("404s for an unknown or erased member, without echoing the id", async () => {
    const { app } = buildApp();

    const res = await get(app, "/api/v1/members/ghost");

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("ghost");
  });

  it("does not shadow the literal /members path", async () => {
    // Registered after it, so "/members" is the list rather than a member called
    // "members". Cheap to assert and expensive to discover.
    const { app, calls } = buildApp();

    await get(app, `/api/v1/members?clinicId=${CLINIC}`);

    expect(calls[0]).toMatchObject({ clinicId: CLINIC });
  });
});

describe("GET /clinics/:slug/members", () => {
  it("scopes by the slug the staff session carries, with no query needed", async () => {
    // The shape the dashboard actually reaches for: its Next handler holds the staff key
    // and derives the clinic from the session, and the session carries the slug. In the
    // path, a caller cannot omit it.
    const { app, calls } = buildApp();

    const res = await get(app, "/api/v1/clinics/aurea/members");

    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ clinicId: CLINIC });
  });

  it("404s an unknown slug rather than returning an empty list", async () => {
    // An unknown clinic and a clinic with no members are different things, and
    // conflating them hides a misconfigured dashboard.
    const { app } = buildApp();

    expect((await get(app, "/api/v1/clinics/nope/members")).status).toBe(404);
  });

  it("still honours search and paging", async () => {
    const { app, calls } = buildApp();

    await get(app, "/api/v1/clinics/aurea/members?q=nav&limit=10&offset=5");

    expect(calls[0]).toMatchObject({ query: "nav", limit: 10, offset: 5 });
  });
});

describe("GET /points/treatments", () => {
  it("requires clinicId too", async () => {
    const { app } = buildApp();

    expect((await get(app, "/api/v1/points/treatments")).status).toBe(422);
  });

  it("returns the clinic's treatments in the shape the scan flow expects", async () => {
    const { app } = buildApp();

    const res = await get(app, `/api/v1/points/treatments?clinicId=${CLINIC}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "t-1", name: "Hydrafacial", priceEuro: 120, points: 120 }]);
  });
});
