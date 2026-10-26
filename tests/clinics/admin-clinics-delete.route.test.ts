import { Prisma } from "@prisma/client";
import express, { type Express } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorHandler } from "../../src/common/middleware/error-handler";

/**
 * The admin clinic delete, against the real schema, with the database stubbed out.
 *
 * The handler clears the clinic's dependants by hand instead of relying on database
 * cascades, because most of the foreign keys are Restrict/NoAction on purpose — a
 * points ledger is a financial record and must not vanish implicitly. That hand-written
 * list is the whole safety of the endpoint: miss one table and Postgres rejects the
 * member or clinic delete with a foreign key violation (P2003), which the error handler
 * answers with a 500 and the admin panel cannot delete a clinic at all. That is not a
 * hypothetical — it is exactly what shipping the loyalty engine tables without touching
 * this handler did to production.
 *
 * So rather than assert a fixed list of delete calls, which goes stale the moment the
 * schema grows, the test derives the expected list from the Prisma DMMF every run: every
 * model holding a non-cascading foreign key to a row the handler deletes must itself be
 * deleted first. A new Restrict table then fails this test until the handler covers it,
 * instead of failing production the first time a clinic with data in it is removed.
 */

// The route module reads config (env.ts) at import time, so the variables it requires
// exist before any import is evaluated. Defaults, not assignments: a real environment
// wins, and the test never re-points a deployment's configuration at a stub.
const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://voone:voone@localhost:5432/voone?schema=public";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.PORT ??= "4000";
  process.env.FRONTEND_URL ??= "http://localhost:3000";
  process.env.STAFF_API_KEY ??= "test-staff-key-0123456789abcdef";

  /** Every tx delete the handler issues, in order, as "model:method" strings. */
  const deletes: string[] = [];

  /**
   * A tx that records deletes instead of running them. A Proxy over every delegate name,
   * so the handler never crashes on a table the fixture forgot — it records what it was
   * asked to do and the assertions below decide whether that was enough.
   */
  const tx = new Proxy(
    {},
    {
      get: (_target, delegate: string | symbol) => ({
        deleteMany: () => {
          deletes.push(`${String(delegate)}:deleteMany`);
          return Promise.resolve({ count: 0 });
        },
        delete: () => {
          deletes.push(`${String(delegate)}:delete`);
          return Promise.resolve({ count: 1 });
        }
      })
    }
  );

  const prisma = {
    clinic: {
      findUnique: vi.fn().mockResolvedValue({
        id: "c1",
        name: "AURÉA",
        slug: "test-delete",
        addressLine: "Calle de Serrano 21",
        pincode: "28001",
        isActive: true,
        privacyPolicyVersion: "v2",
        voonePlan: "starter",
        notificationsMonthlyQuota: 8,
        notificationsUsedThisMonth: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    },
    // Runs the callback inline: the transaction is here for atomicity, not control flow.
    $transaction: vi.fn(async (run: (handle: unknown) => Promise<unknown>) => run(tx))
  };

  return { deletes, prisma };
});

vi.mock("../../src/infrastructure/database/prisma-client", () => ({
  prisma: mocks.prisma,
  default: mocks.prisma
}));

// Imported after the mock: the router must be built against the stubbed client.
import { adminClinicsRouter } from "../../src/routes/v1/admin-clinics.route";

const app = ((): Express => {
  const a = express();

  a.use("/api/v1", adminClinicsRouter);
  a.use(errorHandler);

  return a;
})();

const del = async (path: string): Promise<{ status: number; body: string }> => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method: "DELETE",
      headers: { "x-voone-staff-key": process.env.STAFF_API_KEY ?? "" }
    });

    return { status: response.status, body: await response.text() };
  } finally {
    server.close();
  }
};

/** The delegate name the handler addresses a model by: MemberReward -> memberReward. */
const delegateOf = (model: string): string => model.charAt(0).toLowerCase() + model.slice(1);

/**
 * Every model holding a foreign key to `parent` that the database will NOT follow with a
 * cascade or a SetNull. Only the side that carries the columns counts — a one-to-many
 * back-relation (Clinic.members) points at the parent but holds no foreign key — and
 * Restrict and NoAction both refuse the parent's delete, while an unset onDelete is
 * NoAction, so only the two named actions are ever safe to omit.
 */
const dependantsThatBlock = (parent: string): string[] =>
  Prisma.dmmf.datamodel.models
    .filter((model) =>
      model.fields.some(
        (field) =>
          field.kind === "object" &&
          !field.isList &&
          (field.relationFromFields?.length ?? 0) > 0 &&
          field.type === parent &&
          field.relationOnDelete !== "Cascade" &&
          field.relationOnDelete !== "SetNull"
      )
    )
    .map((model) => model.name);

/** The recorded entry that removes `model`'s rows: deleteMany, or delete for the clinic. */
const deleteRecordOf = (model: string): string =>
  `${delegateOf(model)}:${model === "Clinic" ? "delete" : "deleteMany"}`;

describe("DELETE /admin/clinics/:clinicId", () => {
  beforeEach(() => {
    mocks.deletes.length = 0;
  });

  it("deletes the clinic and answers 204", async () => {
    const res = await del("/admin/clinics/c1");

    expect(res.status).toBe(204);
    expect(mocks.deletes.filter((entry) => entry === "clinic:delete")).toHaveLength(1);
  });

  it("answers 404 without touching anything when the clinic does not exist", async () => {
    mocks.prisma.clinic.findUnique.mockResolvedValueOnce(null);

    const res = await del("/admin/clinics/missing");

    expect(res.status).toBe(404);
    expect(mocks.deletes).toHaveLength(0);
  });

  /**
   * The second way this endpoint broke: the thirteen sequential deletes of a real clinic
   * run well past Prisma's 5s interactive-transaction default (13.7s measured against a
   * local database), whereupon Prisma abandoned the transaction mid-list (P2028) and the
   * clinic was left undeleted. The timeout must therefore be raised above the default —
   * anything left at 5s cannot delete a clinic that has actually been used.
   */
  it("raises the transaction timeout above Prisma's 5s default", async () => {
    await del("/admin/clinics/c1");

    // The handler passes (callback, options); the mock's signature types calls as a
    // 1-tuple, so the record itself is cast before the options are read off it.
    const call = mocks.prisma.$transaction.mock.calls[0] as unknown as
      [unknown, { timeout?: number }] | undefined;

    expect(call?.[1]?.timeout ?? 0).toBeGreaterThan(5_000);
  });

  /**
   * The regression that broke production: the loyalty engine tables (points ledger,
   * visits, rewards, referrals) and the notification deliveries all hold non-cascading
   * foreign keys to Member and Clinic, and the handler's hand-written list predates
   * them. Any clinic with real activity failed to delete with a 500 until every one of
   * them was cleared first.
   *
   * Derived from the schema on every run, so it is the schema — not this file — that
   * decides which tables count. OnboardingProgram is never deleted by hand: it follows
   * the clinic as a cascade, so anything restricted on it must precede clinic:delete.
   */
  it("clears every table that would block the member and clinic deletes, first", async () => {
    await del("/admin/clinics/c1");

    const parents = ["Clinic", "Member", "ClinicTemplate", "OnboardingProgram"];

    for (const parent of parents) {
      const parentRecord =
        parent === "OnboardingProgram" ? "clinic:delete" : deleteRecordOf(parent);
      const parentIndex = mocks.deletes.indexOf(parentRecord);

      expect(
        parentIndex,
        `${parent} rows must be deleted by the handler (or cascade from clinic:delete)`
      ).toBeGreaterThanOrEqual(0);

      for (const dependant of dependantsThatBlock(parent)) {
        const dependantIndex = mocks.deletes.findIndex((entry) =>
          entry.startsWith(`${delegateOf(dependant)}:`)
        );

        expect(
          dependantIndex,
          `${dependant} holds a blocking foreign key to ${parent} and must be deleted first`
        ).toBeGreaterThanOrEqual(0);
        expect(dependantIndex).toBeLessThan(parentIndex);
      }
    }
  });

  /** The same list, spelled out, so a failure names the table the DMMF loop hid. */
  it("explicitly includes the loyalty engine tables that broke production", async () => {
    await del("/admin/clinics/c1");

    for (const model of [
      "PointsTransaction",
      "PaidVisit",
      "MemberReward",
      "Referral",
      "NotificationDelivery",
      "WalletObject",
      "Member",
      "WalletClass",
      "ClinicTemplate",
      "ClinicTreatment",
      "User"
    ]) {
      expect(
        mocks.deletes.some((entry) => entry.startsWith(`${delegateOf(model)}:`)),
        `${model} must be deleted before the clinic`
      ).toBe(true);
    }
  });
});
