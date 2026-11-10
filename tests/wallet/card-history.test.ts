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
import { historyText } from "../../src/wallet/engine/history-text";
import { loyaltyCardSchema, type LoyaltyCard } from "../../src/wallet/engine/loyalty-card";
import { buildStoreCardFields } from "../../src/wallet/providers/apple/apple-pass.fields";
import { PASS_LABELS } from "../../src/wallet/providers/apple/apple-pass.strings";
import { PrismaLoyaltyCardAssembler } from "../../src/wallet/prisma-loyalty-card.assembler";
import catalogFixture from "../onboarding/reference/sapphira.catalogo.json";
import { rewardsPass } from "../fixtures/loyalty-card.fixture";

const history: NonNullable<LoyaltyCard["history"]> = [
  { at: "2026-11-12T10:00:00.000Z", kind: "visit", points: 450 },
  { at: "2026-11-02T09:30:00.000Z", kind: "gift", points: 50 },
  { at: "2026-10-20T16:00:00.000Z", kind: "expiry", points: -120 }
];

const withHistory: LoyaltyCard = { ...rewardsPass, history };

describe("the history text, for the back of the Apple pass", () => {
  it("lists one line per movement, newest first as given, in the 'nov' style", () => {
    expect(historyText(withHistory)).toBe(
      [
        "12 nov · Visita · +450 puntos",
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

  it("groups thousands the Spanish way", () => {
    expect(
      historyText({ history: [{ at: "2026-11-12T10:00:00.000Z", kind: "visit", points: 12500 }] })
    ).toContain("+12.500 puntos");
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
  it("asks for the latest ten movements, newest first with the id as tie-break, in the member's own query", async () => {
    const findUnique = vi.fn(async () => member);

    await assemblerFor(member, findUnique).assemble(member.id);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          pointsLedger: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 10,
            select: { kind: true, points: true, createdAt: true }
          }
        })
      })
    );
  });

  it("never selects the ledger's reason, which is a staff note for an adjustment", async () => {
    const findUnique = vi.fn(async () => member);

    await assemblerFor(member, findUnique).assemble(member.id);

    const args = findUnique.mock.calls[0] as unknown as [
      { include: { pointsLedger: { select: Record<string, boolean> } } }
    ];

    expect(args[0].include.pointsLedger.select).not.toHaveProperty("reason");
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
