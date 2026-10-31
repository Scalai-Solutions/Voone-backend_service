import { PrismaClient, type Clinic } from "@prisma/client";
import express from "express";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";

import { errorHandler } from "../../src/common/middleware/error-handler";
import { findClinicBySlug } from "../../src/modules/clinics/clinic.service";
import { PrismaCatalogueChanges } from "../../src/modules/change-requests/catalogue-changes";
import { PrismaProgramDrafts } from "../../src/modules/change-requests/program-drafts";
import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";
import { OnboardingService } from "../../src/modules/onboarding/onboarding.service";
import { PrismaChangeRequestRepository } from "../../src/modules/change-requests/prisma.repository";
import { ChangeRequestService } from "../../src/modules/change-requests/service";
import { createChangeRequestsRouter } from "../../src/routes/v1/change-requests.route";

export interface Who {
  actor?: string;
  role?: string;
}

export const OWNER: Who = { actor: "owner@a.test", role: "owner" };
export const MANAGER: Who = { actor: "manager@a.test", role: "manager" };
export const OWNER_B: Who = { actor: "owner@b.test", role: "owner" };
export const ADMIN: Who = { actor: "admin@voone.test", role: "voone_admin" };

export const ticketBody = (over: Record<string, unknown> = {}) => ({
  type: "OTHER",
  title: "Una duda",
  reason: "Necesito ayuda con esto.",
  ...over
});

/**
 * The HTTP contract against a real database. Mounts the router factory alone (not v1Router,
 * which builds queues). Each test file passes its own slug prefix because vitest runs files
 * in parallel on one database; the hooks it registers create the two clinics and wipe their
 * tickets around every test.
 */
export const useRouteHarness = (prefix: string) => {
  const slugA = `${prefix}-a`;
  const slugB = `${prefix}-b`;
  const slugs = [slugA, slugB];
  const db = new PrismaClient();
  const service = new ChangeRequestService(new PrismaChangeRequestRepository(db), {
    changes: new PrismaCatalogueChanges(db),
    programs: new PrismaProgramDrafts(
      db,
      new OnboardingService(db, new PrismaCatalogRepository(db))
    )
  });
  const app = express();

  app.use(express.json());
  app.use(
    "/api/v1",
    createChangeRequestsRouter({
      service,
      findClinic: (slug) => findClinicBySlug(db, slug),
      clinicExists: async (id) => (await db.clinic.count({ where: { id } })) > 0
    })
  );
  app.use(errorHandler);

  const server = app.listen(0);
  const base = () => {
    const address = server.address();

    return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/v1`;
  };

  const call = async (method: string, path: string, who: Who = {}, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (who.actor !== undefined) headers["x-actor"] = who.actor;
    if (who.role !== undefined) headers["x-actor-role"] = who.role;
    const response = await fetch(`${base()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    // An unrouted path is Express's own HTML 404, not JSON.
    const isJson = response.headers.get("content-type")?.includes("json");

    return { status: response.status, body: text && isJson ? JSON.parse(text) : null };
  };

  const wipe = async () => {
    const clinic = { slug: { in: slugs } };

    await db.changeRequest.deleteMany({ where: { clinic } });
    await db.clinicTreatment.deleteMany({ where: { clinic } });
    await db.bonoPlan.deleteMany({ where: { clinic } });
    await db.onboardingProgram.deleteMany({ where: { clinic } });
  };
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    const make = (slug: string, name: string) =>
      db.clinic.upsert({
        where: { slug },
        update: { name },
        create: { slug, name, addressLine: "Calle Prueba 2", pincode: "28001" }
      });

    a = await make(slugA, "Clinica Ruta Alfa");
    b = await make(slugB, "Clinica Ruta Beta");
  });

  beforeEach(wipe);

  afterAll(async () => {
    server.close();
    await wipe();
    await db.clinic.deleteMany({ where: { slug: { in: slugs } } });
    await db.$disconnect();
  });

  /** Creates a ticket over HTTP as the clinic's owner (or another caller) and returns it. */
  const make = async (slug = slugA, who: Who = OWNER, over: Record<string, unknown> = {}) => {
    const res = await call("POST", `/clinics/${slug}/change-requests`, who, ticketBody(over));

    expect(res.status).toBe(201);

    return res.body as { id: string };
  };

  /** Moves a ticket the way an admin would, without going through the admin routes. */
  const adminSet = (
    id: string,
    status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "REJECTED",
    resolutionNote?: string
  ) => service.adminSetStatus(id, { email: "admin@voone.test" }, { status, resolutionNote });

  const adminSay = (id: string, body: string) =>
    service.adminReply(id, { email: "admin@voone.test" }, body);

  return {
    db,
    service,
    slugA,
    slugB,
    call,
    make,
    adminSet,
    adminSay,
    get a() {
      return a;
    },
    get b() {
      return b;
    }
  };
};
