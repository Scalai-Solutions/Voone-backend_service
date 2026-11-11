import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

// Settings of the original programme: this suite is not about the tuned ladder (tuning.test.ts is).
vi.mock("../../src/modules/onboarding/engine.config", async (importOriginal) => {
  const { referenceTuningMock } = await import("../onboarding/reference-tuning");

  return referenceTuningMock(importOriginal as never);
});

import { run } from "../../src/modules/onboarding/engine";
import type { CatalogItem } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { paymentReason } from "../../src/modules/onboarding/runtime/visit.service";
import { treatmentNameOf } from "../../src/modules/onboarding/runtime/visit-reason";
import { historyText } from "../../src/wallet/engine/history-text";
import { loyaltyCardSchema, type LoyaltyCard } from "../../src/wallet/engine/loyalty-card";
import { buildStoreCardFields } from "../../src/wallet/providers/apple/apple-pass.fields";
import { PASS_LABELS } from "../../src/wallet/providers/apple/apple-pass.strings";
import { PrismaLoyaltyCardAssembler } from "../../src/wallet/prisma-loyalty-card.assembler";
import catalogFixture from "../onboarding/reference/sapphira.catalogo.json";
import { rewardsPass } from "../fixtures/loyalty-card.fixture";

const history: NonNullable<LoyaltyCard["history"]> = [
  { at: "2026-11-12T10:00:00.000Z", kind: "visit", name: "Limpieza facial", points: 450 },
  { at: "2026-11-02T09:30:00.000Z", kind: "gift", points: 50 },
  { at: "2026-10-20T16:00:00.000Z", kind: "expiry", points: -120 }
];

const withHistory: LoyaltyCard = { ...rewardsPass, history };

describe("the history text, for the back of the Apple pass", () => {
  it("lists one line per movement, newest first as given, in the 'nov' style", () => {
    expect(historyText(withHistory)).toBe(
      [
        "12 nov · Limpieza facial · +450 puntos",
        "2 nov · Puntos de regalo · +50 puntos",
        "20 oct · Caducidad · −120 puntos"
      ].join("\n")
    );
  });

  it("dates a movement in Europe/Madrid, so one just before midnight UTC lands on the next day", () => {
    expect(
      historyText({ history: [{ at: "2026-11-12T23:30:00.000Z", kind: "visit", points: 10 }] })
    ).toBe("13 nov · Visita · +10 puntos");
  });

  it("cuts a long name with an ellipsis, so one line stays one line", () => {
    const text = historyText({
      history: [{ at: "2026-11-12T10:00:00.000Z", kind: "visit", name: "A".repeat(60), points: 10 }]
    });

    expect(text).toBe(`12 nov · ${"A".repeat(39)}… · +10 puntos`);
  });

  it("groups thousands the Spanish way", () => {
    expect(
      historyText({ history: [{ at: "2026-11-12T10:00:00.000Z", kind: "visit", points: 12500 }] })
    ).toContain("+12.500 puntos");
  });

  it("writes a visit that earned nothing as +0, never −0", () => {
    expect(
      historyText({
        history: [
          { at: "2026-11-12T10:00:00.000Z", kind: "visit", name: "Hiperhidrosis", points: 0 }
        ]
      })
    ).toBe("12 nov · Hiperhidrosis · +0 puntos");
  });

  it("has no text without history, or with an empty one", () => {
    expect(historyText(rewardsPass)).toBeUndefined();
    expect(historyText({ history: [] })).toBeUndefined();
  });
});

describe("the history on the back of the Apple pass", () => {
  const field = (card: LoyaltyCard) =>
    buildStoreCardFields(card).backFields.find((f) => f.key === "history");

  it("is a back field labelled HISTORIAL with the lines, and no lock-screen message", () => {
    expect(field(withHistory)).toMatchObject({
      key: "history",
      label: "HISTORIAL",
      value: historyText(withHistory)
    });
    expect(field(withHistory)).not.toHaveProperty("changeMessage");
    expect(PASS_LABELS.history).toBe("HISTORIAL");
  });

  it("is absent for a card with no history", () => {
    expect(field(rewardsPass)).toBeUndefined();
  });

  it("keeps every key unique with every back field present", () => {
    const full: LoyaltyCard = {
      ...withHistory,
      boost: { kind: "perk" },
      referral: { code: "AB2CD", url: "https://voone.app/alta/clinica-aurea?ref=AB2CD" },
      message: { text: "12 nov · Hola: gracias" }
    };
    const keys = buildStoreCardFields(full).backFields.map((f) => f.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never reaches the Google card's text: the schema carries it, only Apple renders it", () => {
    expect(loyaltyCardSchema.safeParse(withHistory).success).toBe(true);
  });
});

const SECRET = "a-server-secret-not-a-member-attribute";

const member = {
  id: "00000000-0000-4000-8000-00000000c123",
  name: "Verónica Navarro",
  pointsBalance: 1250,
  tier: "Gold",
  code: "K7M2Q",
  memberSince: 2026,
  erasedAt: null,
  clinic: {
    id: "clinic-1",
    name: "AURÉA",
    template: {
      programName: "Clinic Club",
      hexBackgroundColor: "#f1dccd",
      pointsLabel: "Saldo Beauty",
      tierLabel: "Nivel"
    }
  }
};

const NO_REFERRAL = {
  referral: { findUnique: vi.fn(async () => null) },
  paidVisit: { findFirst: vi.fn(async () => null) }
};

const assemblerFor = (value: unknown, findUnique = vi.fn(async () => value)) =>
  new PrismaLoyaltyCardAssembler(
    { member: { findUnique }, ...NO_REFERRAL } as unknown as PrismaClient,
    SECRET
  );

const row = (kind: string, points: number, createdAt: string) => ({
  kind,
  points,
  createdAt: new Date(createdAt)
});

describe("PrismaLoyaltyCardAssembler: the history", () => {
  it("asks for the latest five movements, newest first with the id as tie-break, in the member's own query", async () => {
    const findUnique = vi.fn(async () => member);

    await assemblerFor(member, findUnique).assemble(member.id);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          pointsLedger: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 5,
            select: { kind: true, points: true, reason: true, createdAt: true }
          }
        })
      })
    );
  });

  it("gives a visit the treatment name reception recorded, and a bare visit none", async () => {
    const card = await assemblerFor({
      ...member,
      pointsLedger: [
        {
          ...row("EARN", 45, "2026-11-12T10:00:00.000Z"),
          reason: "Visita de pago: Limpieza facial"
        },
        { ...row("EARN", 30, "2026-11-10T10:00:00.000Z"), reason: "Visita de pago" },
        { ...row("EARN", 20, "2026-11-08T10:00:00.000Z"), reason: "Sesión de bono: Pack láser" },
        {
          ...row("EARN", 20, "2026-11-06T10:00:00.000Z"),
          reason: "Visita de pago (doble por recomendación)"
        }
      ]
    }).assemble(member.id);

    expect(card.history?.map((entry) => entry.name)).toEqual([
      "Limpieza facial",
      undefined,
      "Pack láser",
      undefined
    ]);
  });

  it("uses a name only from a visit: a staff note on any other kind never becomes one", async () => {
    const card = await assemblerFor({
      ...member,
      pointsLedger: [
        { ...row("ADJUSTMENT", 30, "2026-11-12T10:00:00.000Z"), reason: "Visita de pago: Botox" },
        { ...row("REFERRAL", 30, "2026-11-11T10:00:00.000Z"), reason: "Visita de pago: Botox" }
      ]
    }).assemble(member.id);

    expect(card.history?.every((entry) => entry.name === undefined)).toBe(true);
  });

  it("reads back exactly the names the visit service writes", () => {
    expect(treatmentNameOf(paymentReason([{ name: "Limpieza facial", amountEuro: 50 }]))).toBe(
      "Limpieza facial"
    );
    expect(
      treatmentNameOf(
        paymentReason([
          { name: "Limpieza facial", amountEuro: 50 },
          { name: "Sérum", amountEuro: 20 }
        ])
      )
    ).toBe("Limpieza facial, Sérum");
    expect(treatmentNameOf(paymentReason([{ amountEuro: 50 }]))).toBeUndefined();
  });

  it("cuts a very long name to what the card accepts instead of failing the card", async () => {
    const card = await assemblerFor({
      ...member,
      pointsLedger: [
        {
          ...row("EARN", 45, "2026-11-12T10:00:00.000Z"),
          reason: `Visita de pago: ${"A".repeat(190)}`
        }
      ]
    }).assemble(member.id);

    expect(card.history?.[0].name?.length).toBeLessThanOrEqual(60);
  });

  it("puts the rows on the card as they are for a clinic with no programme", async () => {
    const card = await assemblerFor({
      ...member,
      pointsLedger: [
        row("EARN", 45, "2026-11-12T10:00:00.000Z"),
        row("REDEEM", -20, "2026-11-01T10:00:00.000Z")
      ]
    }).assemble(member.id);

    expect(card.history).toEqual([
      { at: "2026-11-12T10:00:00.000Z", kind: "visit", points: 45 },
      { at: "2026-11-01T10:00:00.000Z", kind: "redeem", points: -20 }
    ]);
  });

  it("converts euro progress to points (ten per euro) at a programme centre, the way the balance is", async () => {
    const result = run(catalogFixture as CatalogItem[], {
      ticket: null,
      freq: null,
      objective: "equilibrado",
      investment: "equilibrado",
      occupancy: "o2",
      members: "m3"
    });

    if (isEngineError(result)) throw new Error(result.error);

    const card = await assemblerFor({
      ...member,
      tier: "Bronce",
      lifetimePoints: 45,
      clinic: { ...member.clinic, onboardingPrograms: [{ output: result }] },
      pointsLedger: [row("EARN", 45, "2026-11-12T10:00:00.000Z")]
    }).assemble(member.id);

    expect(card.history).toEqual([{ at: "2026-11-12T10:00:00.000Z", kind: "visit", points: 450 }]);
  });

  it("names a manual adjustment by its sign, and a referral and an expiry by their kind", async () => {
    const card = await assemblerFor({
      ...member,
      pointsLedger: [
        row("ADJUSTMENT", 30, "2026-11-12T10:00:00.000Z"),
        row("ADJUSTMENT", -30, "2026-11-11T10:00:00.000Z"),
        row("REFERRAL", 50, "2026-11-10T10:00:00.000Z"),
        row("EXPIRY", -5, "2026-11-09T10:00:00.000Z")
      ]
    }).assemble(member.id);

    expect(card.history?.map((entry) => entry.kind)).toEqual([
      "gift",
      "adjustment",
      "referral",
      "expiry"
    ]);
  });

  it("keeps a staff note out of the card even if a row carries one", async () => {
    const card = await assemblerFor({
      ...member,
      pointsLedger: [
        { ...row("ADJUSTMENT", 30, "2026-11-12T10:00:00.000Z"), reason: "Botox para la Sra. Pérez" }
      ]
    }).assemble(member.id);

    expect(JSON.stringify(card)).not.toContain("Botox");
  });

  it("leaves out a row that rounds to nothing, and the whole field when none is left", async () => {
    const card = await assemblerFor({
      ...member,
      pointsLedger: [row("EARN", 0, "2026-11-12T10:00:00.000Z")]
    }).assemble(member.id);

    expect(card.history).toBeUndefined();
  });

  it("asks for the latest visits that earned no points, which have no ledger row", async () => {
    const findUnique = vi.fn(async () => member);

    await assemblerFor(member, findUnique).assemble(member.id);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          paidVisits: {
            where: { progressAwarded: 0 },
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
            take: 5,
            select: { reason: true, occurredAt: true }
          }
        })
      })
    );
  });

  it("lists a zero-point visit at +0 among the movements, newest first, five at most", async () => {
    const card = await assemblerFor({
      ...member,
      pointsLedger: [
        row("EARN", 45, "2026-11-12T10:00:00.000Z"),
        row("EARN", 30, "2026-11-08T10:00:00.000Z"),
        row("EARN", 20, "2026-11-06T10:00:00.000Z"),
        row("EARN", 10, "2026-11-04T10:00:00.000Z"),
        row("EARN", 5, "2026-11-02T10:00:00.000Z")
      ],
      paidVisits: [
        {
          reason: "Visita de pago: Hiperhidrosis",
          occurredAt: new Date("2026-11-10T10:00:00.000Z")
        },
        { reason: null, occurredAt: new Date("2026-11-01T10:00:00.000Z") }
      ]
    }).assemble(member.id);

    expect(card.history).toEqual([
      { at: "2026-11-12T10:00:00.000Z", kind: "visit", points: 45 },
      { at: "2026-11-10T10:00:00.000Z", kind: "visit", name: "Hiperhidrosis", points: 0 },
      { at: "2026-11-08T10:00:00.000Z", kind: "visit", points: 30 },
      { at: "2026-11-06T10:00:00.000Z", kind: "visit", points: 20 },
      { at: "2026-11-04T10:00:00.000Z", kind: "visit", points: 10 }
    ]);
    expect(loyaltyCardSchema.safeParse(card).success).toBe(true);
  });

  it("has no history for a member with an empty ledger", async () => {
    expect((await assemblerFor(member).assemble(member.id)).history).toBeUndefined();
    expect(
      (await assemblerFor({ ...member, pointsLedger: [] }).assemble(member.id)).history
    ).toBeUndefined();
  });

  it("builds the same card twice from the same ledger, so an unchanged member never pushes", async () => {
    const value = { ...member, pointsLedger: [row("EARN", 45, "2026-11-12T10:00:00.000Z")] };
    const first = await assemblerFor(value).assemble(member.id);
    const second = await assemblerFor(value).assemble(member.id);

    expect(second).toEqual(first);
  });
});
