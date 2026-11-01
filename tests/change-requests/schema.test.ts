import { describe, expect, it } from "vitest";

import {
  adminListQuerySchema,
  createChangeRequestSchema,
  messageSchema,
  ownerListQuerySchema,
  reopenSchema,
  statusUpdateSchema
} from "../../src/modules/change-requests/schema";

const base = { title: "Cambiar la recompensa", reason: "Queremos otra cosa para este hito." };

const parse = (extra: Record<string, unknown>) =>
  createChangeRequestSchema.safeParse({ ...base, ...extra });

describe("createChangeRequestSchema: common fields", () => {
  it("accepts a bare OTHER ticket and trims title and reason", () => {
    const res = createChangeRequestSchema.safeParse({
      type: "OTHER",
      title: "  Hola  ",
      reason: "  Necesito ayuda con algo.  "
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.title).toBe("Hola");
      expect(res.data.reason).toBe("Necesito ayuda con algo.");
      expect(res.data.proposed).toBeUndefined();
      expect(res.data.targetRef).toBeUndefined();
    }
  });

  it("rejects an unknown type and unknown top-level keys", () => {
    expect(parse({ type: "NOPE" }).success).toBe(false);
    expect(parse({ type: "OTHER", clinicId: "x" }).success).toBe(false);
    expect(parse({ type: "OTHER", status: "RESOLVED" }).success).toBe(false);
  });

  it.each([
    ["short reason", { reason: "ab" }],
    ["blank reason", { reason: "     " }],
    ["long reason", { reason: "x".repeat(2001) }],
    ["empty title", { title: "  " }],
    ["long title", { title: "x".repeat(121) }],
    ["non-string title", { title: 5 }]
  ])("rejects %s", (_name, over) => {
    expect(parse({ type: "OTHER", ...over }).success).toBe(false);
  });

  it("accepts the length limits exactly", () => {
    expect(parse({ type: "OTHER", title: "x".repeat(120), reason: "y".repeat(2000) }).success).toBe(
      true
    );
    expect(parse({ type: "OTHER", reason: "abc" }).success).toBe(true);
  });

  it("strips control characters, keeping line breaks in the reason only", () => {
    const res = parse({
      type: "OTHER",
      title: "Uno\ndos\u0000\u0007 tres",
      reason: "Linea 1\r\nLinea 2\u0000\u001b\tfin"
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.title).toBe("Uno dos tres");
      expect(res.data.reason).toBe("Linea 1\nLinea 2\tfin");
    }
  });

  it("measures the reason after stripping, so control characters cannot pad it", () => {
    expect(parse({ type: "OTHER", reason: "a\u0000\u0000b" }).success).toBe(false);
  });

  it("gives Spanish messages", () => {
    const res = parse({ type: "OTHER", reason: "ab" });

    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0]?.message).toMatch(/motivo/i);
  });
});

describe("createChangeRequestSchema: proposed per type", () => {
  it("REWARD: milestone, text and itemId, strictly", () => {
    const ok = parse({
      type: "REWARD",
      targetRef: { milestone: 3 },
      proposed: { milestone: 3, text: "Un masaje", itemId: "abc" }
    });

    expect(ok.success).toBe(true);
    expect(parse({ type: "REWARD", proposed: {} }).success).toBe(true);
    expect(parse({ type: "REWARD" }).success).toBe(true);
    expect(parse({ type: "REWARD", proposed: { text: "x".repeat(121) } }).success).toBe(false);
    expect(parse({ type: "REWARD", proposed: { itemId: "x".repeat(65) } }).success).toBe(false);
    expect(parse({ type: "REWARD", proposed: { milestone: "3" } }).success).toBe(false);
    expect(parse({ type: "REWARD", proposed: { milestone: 0 } }).success).toBe(false);
    expect(parse({ type: "REWARD", proposed: { milestone: 1.5 } }).success).toBe(false);
    expect(parse({ type: "REWARD", proposed: { costPct: 0.9 } }).success).toBe(false);
  });

  it("LEVEL: tier and text", () => {
    expect(
      parse({
        type: "LEVEL",
        targetRef: { tier: "plata" },
        proposed: { tier: "plata", text: "Más" }
      }).success
    ).toBe(true);
    expect(parse({ type: "LEVEL", proposed: { tier: 3 } }).success).toBe(false);
    expect(parse({ type: "LEVEL", proposed: { tier: "x".repeat(33) } }).success).toBe(false);
    expect(parse({ type: "LEVEL", proposed: { text: "x".repeat(121) } }).success).toBe(false);
    expect(parse({ type: "LEVEL", proposed: { benefits: [] } }).success).toBe(false);
  });

  it("SERVICE_EDIT: needs a target and at least one change, with the real editable fields", () => {
    const target = { treatmentId: "t-1" };

    expect(
      parse({
        type: "SERVICE_EDIT",
        targetRef: target,
        proposed: { name: "Limpieza", priceEuro: 45.5, categoryId: "FAC" }
      }).success
    ).toBe(true);
    // The target is required: an edit with no treatment cannot be applied.
    expect(parse({ type: "SERVICE_EDIT", proposed: { name: "x" } }).success).toBe(false);
    expect(parse({ type: "SERVICE_EDIT", targetRef: target, proposed: {} }).success).toBe(false);
    expect(parse({ type: "SERVICE_EDIT", targetRef: target }).success).toBe(false);
    expect(
      parse({ type: "SERVICE_EDIT", targetRef: target, proposed: { priceEuro: 0 } }).success
    ).toBe(false);
    expect(
      parse({ type: "SERVICE_EDIT", targetRef: target, proposed: { priceEuro: -3 } }).success
    ).toBe(false);
    expect(
      parse({ type: "SERVICE_EDIT", targetRef: target, proposed: { priceEuro: 1.234 } }).success
    ).toBe(false);
    expect(
      parse({ type: "SERVICE_EDIT", targetRef: target, proposed: { priceEuro: 100001 } }).success
    ).toBe(false);
    expect(
      parse({ type: "SERVICE_EDIT", targetRef: target, proposed: { name: "x".repeat(121) } })
        .success
    ).toBe(false);
    // Points are derived from the price and duration is not editable: neither is accepted.
    expect(
      parse({ type: "SERVICE_EDIT", targetRef: target, proposed: { pointsOverride: 5 } }).success
    ).toBe(false);
    expect(
      parse({ type: "SERVICE_EDIT", targetRef: target, proposed: { durationMin: 30 } }).success
    ).toBe(false);
  });

  it("SERVICE_EDIT: a treatmentId in proposed must match the target", () => {
    expect(
      parse({
        type: "SERVICE_EDIT",
        targetRef: { treatmentId: "t-1" },
        proposed: { treatmentId: "t-2", name: "x" }
      }).success
    ).toBe(false);
    expect(
      parse({
        type: "SERVICE_EDIT",
        targetRef: { treatmentId: "t-1" },
        proposed: { treatmentId: "t-1", name: "x" }
      }).success
    ).toBe(true);
  });

  it("SERVICE_ADD: name and price required, no target", () => {
    expect(
      parse({
        type: "SERVICE_ADD",
        proposed: { name: "Peeling", priceEuro: 60, categoryId: "FAC" }
      }).success
    ).toBe(true);
    expect(parse({ type: "SERVICE_ADD", proposed: { name: "Peeling" } }).success).toBe(false);
    expect(parse({ type: "SERVICE_ADD", proposed: { priceEuro: 60 } }).success).toBe(false);
    expect(parse({ type: "SERVICE_ADD" }).success).toBe(false);
    expect(
      parse({
        type: "SERVICE_ADD",
        targetRef: { treatmentId: "t-1" },
        proposed: { name: "Peeling", priceEuro: 60 }
      }).success
    ).toBe(false);
  });

  it("SERVICE_REMOVE: treatment target required, no proposed fields", () => {
    expect(parse({ type: "SERVICE_REMOVE", targetRef: { treatmentId: "t-1" } }).success).toBe(true);
    expect(
      parse({ type: "SERVICE_REMOVE", targetRef: { treatmentId: "t-1" }, proposed: {} }).success
    ).toBe(true);
    expect(parse({ type: "SERVICE_REMOVE" }).success).toBe(false);
    expect(
      parse({ type: "SERVICE_REMOVE", targetRef: { treatmentId: "t-1" }, proposed: { name: "x" } })
        .success
    ).toBe(false);
  });

  it("BONO: per action, with the real plan fields", () => {
    expect(
      parse({
        type: "BONO",
        proposed: { action: "add", name: "Bono 5", priceEuro: 200, totalSessions: 5 }
      }).success
    ).toBe(true);
    // add needs the whole plan.
    expect(parse({ type: "BONO", proposed: { action: "add", name: "Bono 5" } }).success).toBe(
      false
    );
    expect(
      parse({
        type: "BONO",
        targetRef: { bonoId: "b-1" },
        proposed: { action: "add", name: "Bono 5", priceEuro: 200, totalSessions: 5 }
      }).success
    ).toBe(false);
    expect(
      parse({
        type: "BONO",
        targetRef: { bonoId: "b-1" },
        proposed: { action: "edit", priceEuro: 180 }
      }).success
    ).toBe(true);
    expect(parse({ type: "BONO", proposed: { action: "edit", priceEuro: 180 } }).success).toBe(
      false
    );
    expect(
      parse({ type: "BONO", targetRef: { bonoId: "b-1" }, proposed: { action: "edit" } }).success
    ).toBe(false);
    expect(
      parse({ type: "BONO", targetRef: { bonoId: "b-1" }, proposed: { action: "remove" } }).success
    ).toBe(true);
    expect(
      parse({
        type: "BONO",
        targetRef: { bonoId: "b-1" },
        proposed: { action: "remove", name: "x" }
      }).success
    ).toBe(false);
    expect(parse({ type: "BONO", proposed: { action: "remove" } }).success).toBe(false);
    expect(parse({ type: "BONO", proposed: { action: "explode" } }).success).toBe(false);
    expect(
      parse({
        type: "BONO",
        proposed: { action: "add", name: "x", priceEuro: 10, totalSessions: 101 }
      }).success
    ).toBe(false);
    expect(
      parse({
        type: "BONO",
        proposed: { action: "add", name: "x", priceEuro: 10, totalSessions: 2.5 }
      }).success
    ).toBe(false);
    // A bono ticket must say what to do, or the admin can never apply it.
    expect(parse({ type: "BONO" }).success).toBe(false);
    expect(parse({ type: "BONO", proposed: {} }).success).toBe(false);
  });

  it("OTHER: nothing structured is allowed", () => {
    expect(parse({ type: "OTHER", proposed: {} }).success).toBe(true);
    expect(parse({ type: "OTHER", proposed: { a: 1 } }).success).toBe(false);
    expect(parse({ type: "OTHER", targetRef: { a: 1 } }).success).toBe(false);
  });

  it("targetRef: strict and typed", () => {
    expect(parse({ type: "REWARD", targetRef: { milestone: "3" } }).success).toBe(false);
    expect(parse({ type: "REWARD", targetRef: { tier: "oro" } }).success).toBe(false);
    expect(parse({ type: "REWARD", targetRef: { milestone: 2, extra: 1 } }).success).toBe(false);
    expect(parse({ type: "LEVEL", targetRef: { tier: "" } }).success).toBe(false);
    expect(parse({ type: "REWARD", targetRef: null, proposed: null }).success).toBe(true);
  });

  it("strips control characters from proposed strings", () => {
    const res = parse({
      type: "SERVICE_ADD",
      proposed: { name: "Pe\u0000eling\n", priceEuro: 10 }
    });

    expect(res.success).toBe(true);
    if (res.success) expect(res.data.proposed).toEqual({ name: "Peeling", priceEuro: 10 });
  });
});

describe("other request schemas", () => {
  it("messageSchema: 1..2000 after trimming, strict", () => {
    expect(messageSchema.safeParse({ body: "Hola" }).success).toBe(true);
    expect(messageSchema.safeParse({ body: "   " }).success).toBe(false);
    expect(messageSchema.safeParse({ body: "x".repeat(2001) }).success).toBe(false);
    expect(messageSchema.safeParse({ body: "x".repeat(2000) }).success).toBe(true);
    expect(messageSchema.safeParse({ body: "Hola", authorKind: "VOONE" }).success).toBe(false);
  });

  it("reopenSchema: the message is optional", () => {
    expect(reopenSchema.safeParse({}).success).toBe(true);
    expect(reopenSchema.safeParse({ message: "Sigue pasando" }).success).toBe(true);
    expect(reopenSchema.safeParse({ message: "  " }).success).toBe(false);
    expect(reopenSchema.safeParse({ status: "OPEN" }).success).toBe(false);
  });

  it("statusUpdateSchema: a known status and an optional bounded note", () => {
    expect(
      statusUpdateSchema.safeParse({ status: "RESOLVED", resolutionNote: "Hecho" }).success
    ).toBe(true);
    expect(statusUpdateSchema.safeParse({ status: "IN_PROGRESS" }).success).toBe(true);
    expect(statusUpdateSchema.safeParse({ status: "DONE" }).success).toBe(false);
    expect(
      statusUpdateSchema.safeParse({ status: "OPEN", resolutionNote: "x".repeat(2001) }).success
    ).toBe(false);
    expect(statusUpdateSchema.safeParse({ status: "OPEN", resolvedAt: "2020-01-01" }).success).toBe(
      false
    );
  });

  it("list queries: defaults, bounds and filters", () => {
    const own = ownerListQuerySchema.parse({});

    expect(own.limit).toBe(20);
    expect(ownerListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(ownerListQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(ownerListQuerySchema.parse({ limit: "50", status: "OPEN" })).toMatchObject({
      limit: 50,
      status: "OPEN"
    });
    expect(ownerListQuerySchema.safeParse({ status: "NOPE" }).success).toBe(false);
    expect(ownerListQuerySchema.safeParse({ cursor: "!!!" }).success).toBe(false);

    const admin = adminListQuerySchema.parse({
      status: "RESOLVED",
      clinicId: "c-1",
      type: "BONO",
      q: "  masaje "
    });

    expect(admin).toMatchObject({ status: "RESOLVED", clinicId: "c-1", type: "BONO", q: "masaje" });
    expect(adminListQuerySchema.safeParse({ type: "NOPE" }).success).toBe(false);
    expect(adminListQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBe(false);
  });
});
