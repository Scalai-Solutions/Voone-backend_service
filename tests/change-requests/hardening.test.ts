import { PrismaClient, type Clinic } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ChangeRequestConflictError,
  ChangeRequestLimitError,
  ChangeRequestNotFoundError,
  ChangeRequestValidationError
} from "../../src/common/errors/change-request.errors";
import {
  PrismaCatalogueChanges,
  type CatalogueChanges
} from "../../src/modules/change-requests/catalogue-changes";
import { EmailChangeRequestNotifier } from "../../src/modules/change-requests/email.notifier";
import type { ChangeRequestNotifier } from "../../src/modules/change-requests/notifier";
import { PrismaChangeRequestMailStore } from "../../src/modules/change-requests/prisma.mail-store";
import { PrismaChangeRequestRepository } from "../../src/modules/change-requests/prisma.repository";
import { PrismaProgramDrafts } from "../../src/modules/change-requests/program-drafts";
import {
  ChangeRequestService,
  DEDUPE_WINDOW_MS,
  OPEN_LIMIT
} from "../../src/modules/change-requests/service";
import { SendGridMailer, type Mailer } from "../../src/modules/mail/mailer";
import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";
import { OnboardingService } from "../../src/modules/onboarding/onboarding.service";

/**
 * The review's fixes, on the database: the cap under concurrency, resolution notes kept in the
 * thread, background mail, retry dedupe, the apply guard and category override. Slugs are
 * unique to this file (vitest runs files in parallel on one database).
 */
const db = new PrismaClient();
const SLUGS = ["test-cr-hard-a", "test-cr-hard-b"];

let a: Clinic;
let b: Clinic;
let clock = new Date();

const calls: string[] = [];
const recorder: ChangeRequestNotifier = {
  onCreated: async () => void calls.push("onCreated"),
  onOwnerReply: async () => void calls.push("onOwnerReply"),
  onAdminReply: async () => void calls.push("onAdminReply"),
  onStatusChanged: async () => void calls.push("onStatusChanged")
};

const repo = new PrismaChangeRequestRepository(db);
const changes = new PrismaCatalogueChanges(db);
const programs = new PrismaProgramDrafts(
  db,
  new OnboardingService(db, new PrismaCatalogRepository(db))
);
const service = new ChangeRequestService(repo, {
  notifier: recorder,
  changes,
  programs,
  now: () => clock,
  background: (task) => task
});

const owner = { email: "dueno@hard.test", role: "OWNER" as const };
const admin = { email: "admin@voone.test" };

let counter = 0;
const file = (clinic: Clinic, over: Record<string, unknown> = {}) =>
  service.create(clinic.id, owner, {
    type: "OTHER",
    title: `Duda ${++counter}`,
    reason: "Necesito ayuda.",
    ...over
  } as never);

const wipe = async () => {
  const clinic = { slug: { in: SLUGS } };

  await db.changeRequest.deleteMany({ where: { clinic } });
  await db.catalogItem.deleteMany({ where: { clinic } });
  await db.clinicTreatment.deleteMany({ where: { clinic } });
  await db.onboardingProgram.deleteMany({ where: { clinic } });
};

const row = (id: string) => db.changeRequest.findUniqueOrThrow({ where: { id } });
const unresolved = (clinic: Clinic) =>
  db.changeRequest.count({
    where: { clinicId: clinic.id, status: { in: ["OPEN", "IN_PROGRESS"] } }
  });

beforeAll(async () => {
  const make = (slug: string) =>
    db.clinic.upsert({
      where: { slug },
      update: {},
      create: { slug, name: slug, addressLine: "Calle Prueba 6", pincode: "28001" }
    });

  a = await make(SLUGS[0]!);
  b = await make(SLUGS[1]!);
});

beforeEach(async () => {
  clock = new Date("2026-06-01T10:00:00.000Z");
  calls.length = 0;
  await wipe();
});

afterAll(async () => {
  await wipe();
  await db.clinic.deleteMany({ where: { slug: { in: SLUGS } } });
  await db.$disconnect();
});

/** `open` unresolved tickets plus `closed` resolved ones (closed just now, inside the window). */
const fill = async (open: number, closed: number) => {
  // Closed ones first: filing a 21st open ticket would hit the cap before it could be closed.
  const ids: string[] = [];

  for (let i = 0; i < closed; i++) {
    const t = await file(a);

    await service.adminSetStatus(t.id, admin, { status: "RESOLVED", resolutionNote: "Cerrado" });
    ids.push(t.id);
  }

  for (let i = 0; i < open; i++) await file(a);

  return ids;
};

describe("the open-ticket cap under concurrency", () => {
  it("two simultaneous reopens at 19 leave at most 20", async () => {
    const [first, second] = await fill(19, 2);
    const results = await Promise.allSettled([
      service.reopenAsClinic(a.id, first!, owner),
      service.reopenAsClinic(a.id, second!, owner)
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;

    expect(refused.reason).toBeInstanceOf(ChangeRequestLimitError);
    expect(await unresolved(a)).toBe(OPEN_LIMIT);
  });

  it("a create and a reopen at 19 leave at most 20", async () => {
    const [closed] = await fill(19, 1);
    const results = await Promise.allSettled([
      file(a),
      service.reopenAsClinic(a.id, closed!, owner)
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await unresolved(a)).toBe(OPEN_LIMIT);
  });

  it("a reply that reopens and an admin reopen are held to it too", async () => {
    const [first, second, third] = await fill(19, 3);
    const results = await Promise.allSettled([
      service.replyAsClinic(a.id, first!, owner, "Una cosa más"),
      service.adminSetStatus(second!, admin, { status: "OPEN" }),
      service.reopenAsClinic(a.id, third!, owner)
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await unresolved(a)).toBe(OPEN_LIMIT);
  });

  it("answers the admin's refused reopen in English", async () => {
    const [closed] = await fill(20, 1);
    const error = (await service
      .adminSetStatus(closed!, admin, { status: "OPEN" })
      .catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(ChangeRequestLimitError);
    expect(error.message).toMatch(/already has 20 open requests/);
  });
});

describe("the resolution stays in the thread", () => {
  it("resolve, reopen, resolve again: both notes are in the thread", async () => {
    const t = await file(a);

    await service.adminSetStatus(t.id, admin, {
      status: "RESOLVED",
      resolutionNote: "Primera nota"
    });
    clock = new Date(clock.getTime() + 1000);
    await service.reopenAsClinic(a.id, t.id, owner);
    expect((await row(t.id)).resolutionNote).toBeNull();
    clock = new Date(clock.getTime() + 1000);
    await service.adminSetStatus(t.id, admin, {
      status: "REJECTED",
      resolutionNote: "Segunda nota"
    });

    const detail = await service.getForClinic(a.id, t.id);

    expect(detail.messages.map((m) => m.body)).toEqual(["Primera nota", "Segunda nota"]);
    expect(detail.messages.every((m) => m.authorKind === "VOONE" && m.authorEmail === null)).toBe(
      true
    );
    expect((await service.adminGet(t.id)).messages[0]).toMatchObject({
      authorEmail: "admin@voone.test"
    });
  });

  it("apply and resolve-linked write the note too, in the same step", async () => {
    const applied = await file(a, {
      type: "SERVICE_ADD",
      proposed: { name: "Nuevo", priceEuro: 10 }
    });
    const result = await service.adminApply(applied.id, admin);

    expect((await service.adminGet(applied.id)).messages.map((m) => m.body)).toEqual([
      result.request.resolutionNote
    ]);
    expect(result.request.resolutionNote).toMatch(/^Applied: /);

    const published = await db.onboardingProgram.create({
      data: {
        clinicId: a.id,
        version: 1,
        status: "ACTIVO",
        engineVersion: "t",
        configVersion: "t",
        answers: {},
        catalogSnapshot: [],
        output: {}
      }
    });
    const linked = await file(a, { type: "REWARD" });

    await db.changeRequest.update({ where: { id: linked.id }, data: { programId: published.id } });
    await service.adminResolveLinked(a.id, published.id, admin, "Publicado v1");
    expect((await service.adminGet(linked.id)).messages.map((m) => m.body)).toEqual([
      "Publicado v1"
    ]);
  });

  it("a refused apply writes nothing into the thread", async () => {
    const t = await file(a, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: "nope" },
      proposed: { name: "x" }
    });

    await expect(service.adminApply(t.id, admin)).rejects.toBeInstanceOf(
      ChangeRequestConflictError
    );
    expect(await db.changeRequestMessage.count({ where: { requestId: t.id } })).toBe(0);
  });
});

describe("mail never holds a request", () => {
  const fakeMailer = (send: Mailer["send"]): Mailer => ({ send });

  it("a mailer that hangs does not delay the response", async () => {
    const hanging = new ChangeRequestService(repo, {
      notifier: new EmailChangeRequestNotifier({
        mailer: fakeMailer(() => new Promise<void>(() => {})),
        store: new PrismaChangeRequestMailStore(db),
        supportEmail: "support@voone.test",
        frontendUrl: "https://app.voone.test"
      }),
      now: () => clock
    });
    const started = Date.now();
    const ticket = await hanging.create(a.id, owner, {
      type: "OTHER",
      title: `Colgado ${++counter}`,
      reason: "Necesito ayuda."
    } as never);

    expect(Date.now() - started).toBeLessThan(1500);
    expect(await db.changeRequest.count({ where: { id: ticket.id } })).toBe(1);
  });

  it("a SendGrid that never answers is cut off and recorded as a short code", async () => {
    const pending: Array<Promise<void> | void> = [];
    const slow = new ChangeRequestService(repo, {
      notifier: new EmailChangeRequestNotifier({
        mailer: new SendGridMailer({
          apiKey: "k",
          fromEmail: "f@voone.test",
          timeoutMs: 40,
          fetch: ((_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            })) as unknown as typeof fetch
        }),
        store: new PrismaChangeRequestMailStore(db),
        supportEmail: "support@voone.test",
        frontendUrl: "https://app.voone.test"
      }),
      now: () => clock,
      background: (task) => void pending.push(task)
    });
    const ticket = await slow.create(a.id, owner, {
      type: "OTHER",
      title: `Lento ${++counter}`,
      reason: "Necesito ayuda."
    } as never);

    await Promise.all(pending);
    expect((await row(ticket.id)).lastEmailError).toBe("SENDGRID_TIMEOUT");
  });

  it("resolve-linked answers without waiting for its mails", async () => {
    const published = await db.onboardingProgram.create({
      data: {
        clinicId: a.id,
        version: 1,
        status: "ACTIVO",
        engineVersion: "t",
        configVersion: "t",
        answers: {},
        catalogSnapshot: [],
        output: {}
      }
    });
    const hanging = new ChangeRequestService(repo, {
      notifier: new EmailChangeRequestNotifier({
        mailer: fakeMailer(() => new Promise<void>(() => {})),
        store: new PrismaChangeRequestMailStore(db),
        supportEmail: "support@voone.test",
        frontendUrl: "https://app.voone.test"
      }),
      programs,
      now: () => clock
    });

    for (let i = 0; i < 3; i++) {
      const t = await file(a, { type: "REWARD" });

      await db.changeRequest.update({ where: { id: t.id }, data: { programId: published.id } });
    }

    const started = Date.now();
    const res = await hanging.adminResolveLinked(a.id, published.id, admin, "Hecho");

    expect(Date.now() - started).toBeLessThan(1500);
    expect(res.resolved).toHaveLength(3);
  });

  it("mail bookkeeping does not move updatedAt", async () => {
    const t = await file(a);
    const before = (await row(t.id)).updatedAt.getTime();
    const store = new PrismaChangeRequestMailStore(db);

    await store.recordError(t.id, "SENDGRID_HTTP_500", "owners");
    await store.recordSent(t.id, new Date("2026-01-02T03:04:05.000Z"), "voone");
    const after = await row(t.id);

    expect(after.updatedAt.getTime()).toBe(before);
    expect(after.lastEmailError).toBe("SENDGRID_HTTP_500");
    expect(after.emailSentAt?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("a retried create", () => {
  const body = { type: "OTHER", title: "Cambio de precio", reason: "Subir el precio." } as never;

  it("returns the stored ticket instead of a twin, and tells nobody twice", async () => {
    const first = await service.create(a.id, owner, body);
    const again = await service.create(a.id, owner, body);

    expect(again.id).toBe(first.id);
    expect(await db.changeRequest.count({ where: { clinicId: a.id } })).toBe(1);
    expect(calls.filter((c) => c === "onCreated")).toHaveLength(1);
  });

  it("is a twin only for the same clinic, person, type, title and reason, within a minute", async () => {
    const first = await service.create(a.id, owner, body);

    expect(
      (await service.create(a.id, owner, { ...(body as object), reason: "Otra razón." } as never))
        .id
    ).not.toBe(first.id);
    expect((await service.create(a.id, { ...owner, email: "otro@hard.test" }, body)).id).not.toBe(
      first.id
    );
    expect((await service.create(b.id, owner, body)).id).not.toBe(first.id);

    clock = new Date(clock.getTime() + DEDUPE_WINDOW_MS + 1);
    expect((await service.create(a.id, owner, body)).id).not.toBe(first.id);
  });

  it("answers a retry with the stored ticket even at the cap", async () => {
    const first = await service.create(a.id, owner, body);

    for (let i = 1; i < OPEN_LIMIT; i++) await file(a);
    await expect(service.create(a.id, owner, body)).resolves.toMatchObject({ id: first.id });
    await expect(file(a)).rejects.toBeInstanceOf(ChangeRequestLimitError);
  });
});

describe("apply: guard, category override, warnings", () => {
  const catalogue = async () => {
    for (const [externalId, name] of [
      ["ext-1", "Uno"],
      ["ext-2", "Dos"]
    ] as const) {
      await db.catalogItem.create({
        data: { clinicId: a.id, externalId, name, priceCents: 5000, categoryId: "FAC", position: 0 }
      });
    }
  };

  it("a second apply is a 409 even after a reopen, and the change happens once", async () => {
    const t = await file(b, { type: "SERVICE_ADD", proposed: { name: "Única", priceEuro: 10 } });
    const first = await service.adminApply(t.id, admin);

    expect(first.request.appliedAt).toEqual(expect.any(String));
    expect(first.request.appliedByEmail).toBe("admin@voone.test");
    await service.reopenAsClinic(b.id, t.id, owner);

    const error = (await service
      .adminApply(t.id, admin)
      .catch((e: unknown) => e)) as ChangeRequestConflictError;

    expect(error).toBeInstanceOf(ChangeRequestConflictError);
    expect(error.code).toBe("CHANGE_REQUEST_ALREADY_APPLIED");
    expect(await db.clinicTreatment.count({ where: { clinicId: b.id, name: "Única" } })).toBe(1);
    // appliedAt survives the reopen, and the reopened ticket can still be closed by hand.
    expect((await service.adminGet(t.id)).appliedAt).toBe(first.request.appliedAt);
    await service.adminSetStatus(t.id, admin, { status: "REJECTED", resolutionNote: "Revisado" });
    expect((await row(t.id)).status).toBe("REJECTED");
  });

  it("keeps appliedAt out of every owner response", async () => {
    const t = await file(b, { type: "SERVICE_ADD", proposed: { name: "Oculto", priceEuro: 10 } });

    await service.adminApply(t.id, admin);
    const owned = JSON.stringify([
      await service.getForClinic(b.id, t.id),
      await service.listForClinic(b.id, { limit: 20 })
    ]);

    expect(owned).not.toContain("applied");
    const listed = await service.adminList({ limit: 50, clinicId: b.id });

    expect(listed.items[0]).toMatchObject({ appliedAt: expect.any(String) });
  });

  it("lets the admin supply the category for a SERVICE_ADD that has none", async () => {
    await catalogue();
    const t = await file(a, {
      type: "SERVICE_ADD",
      proposed: { name: "Sin categoría", priceEuro: 20 }
    });

    expect((await service.adminGet(t.id)).needsCategory).toBe(true);
    await expect(service.adminApply(t.id, admin)).rejects.toThrow(/not valid/i);
    await expect(service.adminApply(t.id, admin, { categoryId: "NOPE" })).rejects.toThrow(
      /not valid/i
    );
    expect((await row(t.id)).status).toBe("OPEN");

    await service.adminApply(t.id, admin, { categoryId: "FAC" });
    expect(
      await db.catalogItem.findFirstOrThrow({ where: { clinicId: a.id, name: "Sin categoría" } })
    ).toMatchObject({ categoryId: "FAC" });
  });

  it("needs no category elsewhere, and the owner's own category wins", async () => {
    await catalogue();
    const plain = await file(b, { type: "SERVICE_ADD", proposed: { name: "Liso", priceEuro: 10 } });
    const given = await file(a, {
      type: "SERVICE_ADD",
      proposed: { name: "Con categoría", priceEuro: 10, categoryId: "FAC" }
    });

    expect((await service.adminGet(plain.id)).needsCategory).toBe(false);
    expect((await service.adminGet(given.id)).needsCategory).toBe(false);
    await service.adminApply(given.id, admin, { categoryId: "OTHERCAT" });
    expect(
      await db.catalogItem.findFirstOrThrow({ where: { clinicId: a.id, name: "Con categoría" } })
    ).toMatchObject({ categoryId: "FAC" });
  });

  it("refuses a category on any other kind of ticket", async () => {
    const t = await file(b, {
      type: "BONO",
      proposed: { action: "add", name: "B", priceEuro: 10, totalSessions: 2 }
    });

    await expect(service.adminApply(t.id, admin, { categoryId: "FAC" })).rejects.toBeInstanceOf(
      ChangeRequestValidationError
    );
  });

  it("an impact failure does not break the apply", async () => {
    const broken: CatalogueChanges = {
      apply: (client, ticket, options) => changes.apply(client, ticket, options),
      needsCategory: () => Promise.reject(new Error("boom")),
      impact: () => Promise.reject(new Error("boom"))
    };
    const guarded = new ChangeRequestService(repo, { changes: broken, now: () => clock });
    const t = await file(b, {
      type: "SERVICE_ADD",
      proposed: { name: "Pese a todo", priceEuro: 10 }
    });
    const res = await guarded.adminApply(t.id, admin);

    expect(res.warnings).toEqual([]);
    expect(res.request.status).toBe("RESOLVED");
    expect((await guarded.adminGet(t.id)).catalogueImpact).toBeNull();
  });

  it("a malformed stored programme yields no warnings instead of an error", async () => {
    await catalogue();
    await db.onboardingProgram.create({
      data: {
        clinicId: a.id,
        version: 1,
        status: "ACTIVO",
        engineVersion: "t",
        configVersion: "t",
        answers: {},
        catalogSnapshot: [],
        output: { chosen: "not a list", rec: 7 }
      }
    });
    const item = await db.catalogItem.findFirstOrThrow({ where: { clinicId: a.id } });
    const t = await file(a, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: item.id },
      proposed: { priceEuro: 60 }
    });
    const res = await service.adminApply(t.id, admin);

    expect(res.warnings).toHaveLength(1);
    expect(res.request.status).toBe("RESOLVED");
  });
});

describe("admin-facing messages are English", () => {
  it("not found, invalid transition and the missing note", async () => {
    const t = await file(a);

    await expect(service.adminGet("nope")).rejects.toThrow("Request not found.");
    await expect(service.adminSetStatus(t.id, admin, { status: "OPEN" })).rejects.toThrow(
      /cannot move from OPEN to OPEN/
    );
    await expect(service.adminSetStatus(t.id, admin, { status: "RESOLVED" })).rejects.toThrow(
      "A resolution note is required."
    );
    // The owner side stays Spanish.
    await expect(service.getForClinic(a.id, "nope")).rejects.toBeInstanceOf(
      ChangeRequestNotFoundError
    );
    await expect(service.getForClinic(a.id, "nope")).rejects.toThrow(
      "No se ha encontrado esa solicitud."
    );
  });
});
