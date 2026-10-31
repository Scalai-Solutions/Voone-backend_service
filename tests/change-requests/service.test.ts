import { PrismaClient, type Clinic } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ChangeRequestConflictError,
  ChangeRequestLimitError,
  ChangeRequestNotFoundError,
  ChangeRequestValidationError
} from "../../src/common/errors/change-request.errors";
import type { ChangeRequestNotifier } from "../../src/modules/change-requests/notifier";
import { PrismaChangeRequestRepository } from "../../src/modules/change-requests/prisma.repository";
// Cursors are opaque strings on the wire; the schema decodes them, so decode the same way.
import { decodeCursor as decode } from "../../src/modules/change-requests/schema";
import {
  ChangeRequestService,
  OPEN_LIMIT,
  REOPEN_WINDOW_MS
} from "../../src/modules/change-requests/service";

/**
 * Real database, one file: the repository's compare-and-set, transaction and advisory lock
 * are the behaviour under test, and an in-memory fake would only prove the fake. Slugs are
 * unique to this file because vitest runs files in parallel on one database.
 */
const db = new PrismaClient();
const SLUGS = ["test-cr-svc-a", "test-cr-svc-b"];

let a: Clinic;
let b: Clinic;

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-06-01T10:00:00.000Z");

let clock = T0;
const now = () => clock;

interface Call {
  hook: string;
  args: unknown[];
}

const calls: Call[] = [];
const recorder: ChangeRequestNotifier = {
  onCreated: async (request) => void calls.push({ hook: "onCreated", args: [request] }),
  onOwnerReply: async (request, message, reopenedFrom) =>
    void calls.push({ hook: "onOwnerReply", args: [request, message, reopenedFrom] }),
  onAdminReply: async (request, message) =>
    void calls.push({ hook: "onAdminReply", args: [request, message] }),
  onStatusChanged: async (request, previous, changedBy) =>
    void calls.push({ hook: "onStatusChanged", args: [request, previous, changedBy] })
};

const service = new ChangeRequestService(new PrismaChangeRequestRepository(db), {
  notifier: recorder,
  now
});

const owner = { email: "owner@a.test", role: "OWNER" as const };
const manager = { email: "manager@a.test", role: "MANAGER" as const };
const admin = { email: "admin@voone.test" };

const input = (over: Record<string, unknown> = {}) =>
  ({ type: "OTHER", title: "Una duda", reason: "Necesito ayuda.", ...over }) as never;

const wipe = () => db.changeRequest.deleteMany({ where: { clinic: { slug: { in: SLUGS } } } });

beforeAll(async () => {
  const make = (slug: string, name: string) =>
    db.clinic.upsert({
      where: { slug },
      update: { name },
      create: { slug, name, addressLine: "Calle Prueba 1", pincode: "28001" }
    });

  a = await make("test-cr-svc-a", "Clinica Alfa Cr");
  b = await make("test-cr-svc-b", "Clinica Beta Cr");
});

beforeEach(async () => {
  clock = T0;
  calls.length = 0;
  await wipe();
});

afterAll(async () => {
  await wipe();
  await db.clinic.deleteMany({ where: { slug: { in: SLUGS } } });
  await db.$disconnect();
});

const create = (clinic: Clinic = a, over: Record<string, unknown> = {}) =>
  service.create(clinic.id, owner, input(over));

describe("create", () => {
  it("stores an OPEN ticket with the creator and tells the notifier once", async () => {
    const ticket = await service.create(a.id, manager, input({ title: "Hola" }));

    expect(ticket).toMatchObject({
      status: "OPEN",
      title: "Hola",
      type: "OTHER",
      createdByEmail: "manager@a.test",
      createdByRole: "MANAGER",
      resolvedAt: null
    });
    const row = await db.changeRequest.findUniqueOrThrow({ where: { id: ticket.id } });

    expect(row.clinicId).toBe(a.id);
    expect(calls.map((c) => c.hook)).toEqual(["onCreated"]);
    expect((calls[0]!.args[0] as { clinic: { name: string } }).clinic.name).toBe("Clinica Alfa Cr");
  });

  it("never fails because the notifier does", async () => {
    const failing = new ChangeRequestService(new PrismaChangeRequestRepository(db), {
      notifier: {
        onCreated: async () => {
          throw new Error("mail down");
        },
        onOwnerReply: async () => {},
        onAdminReply: async () => {},
        onStatusChanged: async () => {}
      },
      now
    });

    const ticket = await failing.create(a.id, owner, input());

    expect(await db.changeRequest.count({ where: { id: ticket.id } })).toBe(1);
  });

  it("refuses the 21st non-closed ticket of a clinic, with a Spanish message", async () => {
    for (let i = 0; i < OPEN_LIMIT; i++) await create();

    const error = await create().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChangeRequestLimitError);
    expect((error as Error).message).toMatch(/solicitudes abiertas/);
    // Another clinic has its own allowance.
    await expect(create(b)).resolves.toBeDefined();
  });

  it("counts IN_PROGRESS but not RESOLVED or REJECTED against the limit", async () => {
    const made = [];

    for (let i = 0; i < OPEN_LIMIT; i++) made.push(await create());
    await service.adminSetStatus(made[0]!.id, admin, { status: "IN_PROGRESS" });
    await expect(create()).rejects.toBeInstanceOf(ChangeRequestLimitError);

    await service.adminSetStatus(made[1]!.id, admin, { status: "RESOLVED", resolutionNote: "ok" });
    await expect(create()).resolves.toBeDefined();
    await expect(create()).rejects.toBeInstanceOf(ChangeRequestLimitError);

    await service.adminSetStatus(made[2]!.id, admin, { status: "REJECTED", resolutionNote: "no" });
    await expect(create()).resolves.toBeDefined();
  });

  it("holds the limit under concurrent creates", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: OPEN_LIMIT + 8 }, () => create())
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(OPEN_LIMIT);
    // Every refusal is the limit, not a pool timeout or a deadlock in disguise.
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ChangeRequestLimitError);
    }
    expect(await db.changeRequest.count({ where: { clinicId: a.id } })).toBe(OPEN_LIMIT);
  });
});

describe("tenancy on the clinic side", () => {
  it("answers 404 for another clinic's ticket on every clinic operation", async () => {
    const theirs = await create(b);

    await expect(service.getForClinic(a.id, theirs.id)).rejects.toBeInstanceOf(
      ChangeRequestNotFoundError
    );
    await expect(service.replyAsClinic(a.id, theirs.id, owner, "hola")).rejects.toBeInstanceOf(
      ChangeRequestNotFoundError
    );
    await expect(service.reopenAsClinic(a.id, theirs.id, owner)).rejects.toBeInstanceOf(
      ChangeRequestNotFoundError
    );
    await expect(service.getForClinic(a.id, "no-such-id")).rejects.toBeInstanceOf(
      ChangeRequestNotFoundError
    );
    expect(await db.changeRequestMessage.count({ where: { requestId: theirs.id } })).toBe(0);
  });

  it("lists only the clinic's own tickets", async () => {
    await create(a);
    await create(b);
    const mine = await service.listForClinic(a.id, { limit: 20 });

    expect(mine.items).toHaveLength(1);
  });

  it("hides internal fields from the clinic", async () => {
    const ticket = await create();
    await service.adminReply(ticket.id, admin, "Lo miramos");
    await service.adminSetStatus(ticket.id, admin, { status: "RESOLVED", resolutionNote: "Hecho" });
    await db.changeRequest.update({
      where: { id: ticket.id },
      data: { emailSentAt: T0, lastEmailError: "boom", programId: null }
    });
    const detail = await service.getForClinic(a.id, ticket.id);
    const json = JSON.stringify(detail);

    expect(json).not.toContain("admin@voone.test");
    expect(json).not.toContain("emailSentAt");
    expect(json).not.toContain("lastEmailError");
    expect(json).not.toContain("resolvedByEmail");
    expect(json).not.toContain("programId");
    expect(detail.resolutionNote).toBe("Hecho");
    expect(detail.messages[0]).toMatchObject({ authorKind: "VOONE", authorEmail: null });
  });
});

describe("admin status transitions", () => {
  const STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "REJECTED"] as const;
  const ALLOWED: Record<string, string[]> = {
    OPEN: ["IN_PROGRESS", "RESOLVED", "REJECTED"],
    IN_PROGRESS: ["OPEN", "RESOLVED", "REJECTED"],
    RESOLVED: ["OPEN"],
    REJECTED: ["OPEN"]
  };

  const pairs = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const));

  it.each(pairs)("%s -> %s", async (from, to) => {
    const ticket = await create();

    await db.changeRequest.update({
      where: { id: ticket.id },
      data: {
        status: from,
        resolvedAt: from === "RESOLVED" || from === "REJECTED" ? T0 : null,
        resolutionNote: from === "RESOLVED" || from === "REJECTED" ? "nota" : null
      }
    });

    const attempt = service.adminSetStatus(ticket.id, admin, {
      status: to,
      resolutionNote: "Una nota"
    });

    if (ALLOWED[from]!.includes(to)) {
      const updated = await attempt;

      expect(updated.status).toBe(to);
    } else {
      await expect(attempt).rejects.toBeInstanceOf(ChangeRequestConflictError);
      expect((await db.changeRequest.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe(
        from
      );
    }
  });

  it("requires a non-empty note to resolve or reject", async () => {
    const ticket = await create();

    for (const status of ["RESOLVED", "REJECTED"] as const) {
      await expect(service.adminSetStatus(ticket.id, admin, { status })).rejects.toBeInstanceOf(
        ChangeRequestValidationError
      );
      await expect(
        service.adminSetStatus(ticket.id, admin, { status, resolutionNote: "   " })
      ).rejects.toBeInstanceOf(ChangeRequestValidationError);
    }
    expect((await db.changeRequest.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe(
      "OPEN"
    );
  });

  it("stamps resolvedAt, resolvedByEmail and the note, and tells the notifier", async () => {
    const ticket = await create();

    clock = new Date(T0.getTime() + 5 * DAY);
    calls.length = 0;
    await service.adminSetStatus(ticket.id, admin, {
      status: "RESOLVED",
      resolutionNote: "  Hecho  "
    });
    const row = await db.changeRequest.findUniqueOrThrow({ where: { id: ticket.id } });

    expect(row).toMatchObject({
      status: "RESOLVED",
      resolvedByEmail: "admin@voone.test",
      resolutionNote: "Hecho"
    });
    expect(row.resolvedAt?.toISOString()).toBe(clock.toISOString());
    expect(calls.map((c) => c.hook)).toEqual(["onStatusChanged"]);
    expect(calls[0]!.args.slice(1)).toEqual(["OPEN", "VOONE"]);
  });

  it("clears the resolution when reopening, so a second resolution starts a fresh window", async () => {
    const ticket = await create();

    await service.adminSetStatus(ticket.id, admin, { status: "REJECTED", resolutionNote: "No" });
    await service.adminSetStatus(ticket.id, admin, { status: "OPEN" });
    const row = await db.changeRequest.findUniqueOrThrow({ where: { id: ticket.id } });

    expect(row).toMatchObject({
      status: "OPEN",
      resolvedAt: null,
      resolvedByEmail: null,
      resolutionNote: null
    });
  });

  it("answers 404 for an unknown id", async () => {
    await expect(
      service.adminSetStatus("nope", admin, { status: "IN_PROGRESS" })
    ).rejects.toBeInstanceOf(ChangeRequestNotFoundError);
  });
});

describe("reopen window", () => {
  const closed = async (status: "RESOLVED" | "REJECTED" = "RESOLVED") => {
    const ticket = await create();

    await service.adminSetStatus(ticket.id, admin, { status, resolutionNote: "Cerrado" });
    calls.length = 0;

    return ticket;
  };

  it("allows a reopen at exactly 14 days and refuses one millisecond later", async () => {
    const ticket = await closed();

    clock = new Date(T0.getTime() + REOPEN_WINDOW_MS);
    const reopened = await service.reopenAsClinic(a.id, ticket.id, owner);

    expect(reopened.status).toBe("OPEN");
    expect(REOPEN_WINDOW_MS).toBe(14 * DAY);

    const late = await closed("REJECTED");

    clock = new Date(clock.getTime() + REOPEN_WINDOW_MS + 1);
    await expect(service.reopenAsClinic(a.id, late.id, owner)).rejects.toBeInstanceOf(
      ChangeRequestConflictError
    );
  });

  it("reports when a closed ticket can still be reopened until", async () => {
    const ticket = await closed();
    const detail = await service.getForClinic(a.id, ticket.id);

    expect(detail.reopenableUntil).toBe(new Date(T0.getTime() + REOPEN_WINDOW_MS).toISOString());

    clock = new Date(T0.getTime() + REOPEN_WINDOW_MS + 1);
    expect((await service.getForClinic(a.id, ticket.id)).reopenableUntil).toBeNull();
    const open = await create();

    expect((await service.getForClinic(a.id, open.id)).reopenableUntil).toBeNull();
  });

  it("refuses to reopen a ticket that is not closed", async () => {
    const open = await create();

    await expect(service.reopenAsClinic(a.id, open.id, owner)).rejects.toBeInstanceOf(
      ChangeRequestConflictError
    );
    await service.adminSetStatus(open.id, admin, { status: "IN_PROGRESS" });
    await expect(service.reopenAsClinic(a.id, open.id, owner)).rejects.toBeInstanceOf(
      ChangeRequestConflictError
    );
  });

  it("reopens with an optional message, written with the status change", async () => {
    const ticket = await closed();

    clock = new Date(T0.getTime() + DAY);
    const reopened = await service.reopenAsClinic(a.id, ticket.id, owner, "Sigue fallando");

    expect(reopened.status).toBe("OPEN");
    expect(reopened.messages).toHaveLength(1);
    expect(reopened.messages[0]).toMatchObject({ authorKind: "CLINIC", body: "Sigue fallando" });
    expect(calls.map((c) => c.hook)).toEqual(["onOwnerReply", "onStatusChanged"]);

    const bare = await closed("REJECTED");

    calls.length = 0;
    await service.reopenAsClinic(a.id, bare.id, owner);
    expect(calls.map((c) => c.hook)).toEqual(["onStatusChanged"]);
    expect(calls[0]!.args.slice(1)).toEqual(["REJECTED", "CLINIC"]);
    expect(await db.changeRequestMessage.count({ where: { requestId: bare.id } })).toBe(0);
  });

  it("counts a reopen against the open limit", async () => {
    const ticket = await closed();

    for (let i = 0; i < OPEN_LIMIT; i++) await create();
    await expect(service.reopenAsClinic(a.id, ticket.id, owner)).rejects.toBeInstanceOf(
      ChangeRequestLimitError
    );
  });
});

describe("replies", () => {
  it("a clinic reply on an open ticket adds a message and leaves the status", async () => {
    const ticket = await create();

    await service.adminSetStatus(ticket.id, admin, { status: "IN_PROGRESS" });
    calls.length = 0;
    const detail = await service.replyAsClinic(a.id, ticket.id, manager, "Gracias");

    expect(detail.status).toBe("IN_PROGRESS");
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]).toMatchObject({
      authorKind: "CLINIC",
      authorEmail: "manager@a.test",
      body: "Gracias"
    });
    expect(calls.map((c) => c.hook)).toEqual(["onOwnerReply"]);
  });

  it.each(["RESOLVED", "REJECTED"] as const)(
    "a clinic reply on a %s ticket inside the window reopens it",
    async (status) => {
      const ticket = await create();

      await service.adminSetStatus(ticket.id, admin, { status, resolutionNote: "Cerrado" });
      calls.length = 0;
      clock = new Date(T0.getTime() + 3 * DAY);
      const detail = await service.replyAsClinic(a.id, ticket.id, owner, "Una cosa más");

      expect(detail.status).toBe("OPEN");
      expect(detail.messages).toHaveLength(1);
      expect(
        (await db.changeRequest.findUniqueOrThrow({ where: { id: ticket.id } })).resolvedAt
      ).toBeNull();
      expect(calls.map((c) => c.hook)).toEqual(["onOwnerReply", "onStatusChanged"]);
      expect(calls[0]!.args[2]).toBe(status);
    }
  );

  it("a clinic reply on a closed ticket past the window is a 409 and writes nothing", async () => {
    const ticket = await create();

    await service.adminSetStatus(ticket.id, admin, {
      status: "RESOLVED",
      resolutionNote: "Cerrado"
    });
    clock = new Date(T0.getTime() + REOPEN_WINDOW_MS + 1);

    await expect(service.replyAsClinic(a.id, ticket.id, owner, "Hola")).rejects.toBeInstanceOf(
      ChangeRequestConflictError
    );
    expect(await db.changeRequestMessage.count({ where: { requestId: ticket.id } })).toBe(0);
    expect((await db.changeRequest.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe(
      "RESOLVED"
    );
  });

  it("an admin reply never changes the status, even on a closed ticket", async () => {
    const ticket = await create();

    await service.adminSetStatus(ticket.id, admin, {
      status: "RESOLVED",
      resolutionNote: "Cerrado"
    });
    calls.length = 0;
    clock = new Date(T0.getTime() + 60 * DAY);
    const detail = await service.adminReply(ticket.id, admin, "Por cierto...");

    expect(detail.status).toBe("RESOLVED");
    expect(detail.messages[0]).toMatchObject({
      authorKind: "VOONE",
      authorEmail: "admin@voone.test",
      body: "Por cierto..."
    });
    expect(calls.map((c) => c.hook)).toEqual(["onAdminReply"]);
  });

  it("returns the thread oldest first", async () => {
    const ticket = await create();

    await service.replyAsClinic(a.id, ticket.id, owner, "uno");
    clock = new Date(T0.getTime() + 1000);
    await service.adminReply(ticket.id, admin, "dos");
    clock = new Date(T0.getTime() + 2000);
    const detail = await service.replyAsClinic(a.id, ticket.id, owner, "tres");

    expect(detail.messages.map((m) => m.body)).toEqual(["uno", "dos", "tres"]);
  });
});

describe("listing and pagination", () => {
  const seed = async (count: number, clinic: Clinic = a) => {
    const ids: string[] = [];

    for (let i = 0; i < count; i++) {
      clock = new Date(T0.getTime() + i * 1000);
      ids.push((await create(clinic, { title: `Ticket ${i}` })).id);
    }

    return ids;
  };

  it("pages newest first without gaps or repeats", async () => {
    const ids = await seed(5);
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 3; page++) {
      const res = await service.listForClinic(a.id, {
        limit: 2,
        cursor: cursor ? decode(cursor) : undefined
      });

      seen.push(...res.items.map((i) => i.id));
      cursor = res.nextCursor ?? undefined;
      if (page < 2) expect(cursor).toBeDefined();
    }

    expect(cursor).toBeUndefined();
    expect(seen).toEqual([...ids].reverse());
  });

  it("breaks createdAt ties by id so a page boundary inside a tie is stable", async () => {
    clock = T0;
    for (let i = 0; i < 5; i++) await create();

    const first = await service.listForClinic(a.id, { limit: 2 });
    const second = await service.listForClinic(a.id, {
      limit: 2,
      cursor: decode(first.nextCursor!)
    });
    const third = await service.listForClinic(a.id, {
      limit: 2,
      cursor: decode(second.nextCursor!)
    });
    const all = [...first.items, ...second.items, ...third.items].map((i) => i.id);

    expect(new Set(all).size).toBe(5);
    expect(third.nextCursor).toBeNull();
  });

  it("filters the clinic list by status", async () => {
    const [x, y] = await seed(2);

    await service.adminSetStatus(x!, admin, { status: "IN_PROGRESS" });
    const res = await service.listForClinic(a.id, { limit: 20, status: "IN_PROGRESS" });

    expect(res.items.map((i) => i.id)).toEqual([x]);
    expect(y).toBeDefined();
  });

  it("admin list: all clinics, with clinic name/slug, message count and last message time", async () => {
    const [x] = await seed(2, a);
    const [y] = await seed(1, b);

    clock = new Date(T0.getTime() + 99_000);
    await service.adminReply(x!, admin, "hola");
    // No clinic filter: other test files share this database, so keep only our own rows.
    const res = await service.adminList({ limit: 50 });
    const scope = [a.id, b.id];

    res.items = res.items.filter((i) => scope.includes(i.clinicId));
    expect(res.items).toHaveLength(3);
    const row = res.items.find((i) => i.id === x)!;

    expect(row.clinic).toEqual({ id: a.id, name: "Clinica Alfa Cr", slug: "test-cr-svc-a" });
    expect(row.messageCount).toBe(1);
    expect(row.lastMessageAt).toBe(clock.toISOString());
    expect(res.items.find((i) => i.id === y)!.lastMessageAt).toBeNull();
  });

  it("admin list filters: status, clinic, type and text on title or clinic name", async () => {
    const [x] = await seed(2, a);
    const typed = await create(b, { type: "BONO", title: "Precio del bono" });

    await service.adminSetStatus(x!, admin, { status: "RESOLVED", resolutionNote: "ok" });
    const scope = [a.id, b.id];
    // Other test files share this database: keep only our own clinics' rows.
    const ids = async (q: Record<string, unknown>) =>
      (await service.adminList({ limit: 50, ...q })).items
        .filter((i) => scope.includes(i.clinicId))
        .map((i) => i.id);

    expect(await ids({ status: "RESOLVED" })).toEqual([x]);
    expect(await ids({ clinicId: b.id })).toEqual([typed.id]);
    expect(await ids({ type: "BONO" })).toEqual([typed.id]);
    expect(await ids({ q: "PRECIO" })).toEqual([typed.id]);
    expect(await ids({ q: "alfa" })).toHaveLength(2);
    expect(await ids({ q: "no-match-at-all" })).toEqual([]);
  });

  it("admin detail returns the thread and the internal fields", async () => {
    const ticket = await create();

    await service.adminReply(ticket.id, admin, "hola");
    const detail = await service.adminGet(ticket.id);

    expect(detail.clinic.slug).toBe("test-cr-svc-a");
    expect(detail.messages).toHaveLength(1);
    expect(detail).toHaveProperty("emailSentAt");
    expect(detail).toHaveProperty("lastEmailError");
    expect(detail).toHaveProperty("programId");
    await expect(service.adminGet("nope")).rejects.toBeInstanceOf(ChangeRequestNotFoundError);
  });
});
