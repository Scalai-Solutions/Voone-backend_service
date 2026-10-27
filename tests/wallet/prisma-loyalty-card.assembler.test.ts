import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MemberNotFoundError } from "../../src/common/errors/membership.errors";
import { WalletConfigurationError } from "../../src/common/errors/wallet.errors";
import { run } from "../../src/modules/onboarding/engine";
import type { CatalogItem } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import catalogFixture from "../onboarding/reference/sapphira.catalogo.json";
import { PrismaLoyaltyCardAssembler } from "../../src/wallet/prisma-loyalty-card.assembler";

const SECRET = "a-server-secret-not-a-member-attribute";

const template = {
  programName: "Clinic Club",
  hexBackgroundColor: "#f1dccd",
  pointsLabel: "Saldo Beauty",
  tierLabel: "Nivel",
  benefitsText: "Acceso exclusivo a tratamientos, eventos y ofertas para miembros.",
  infoText: "Presenta este pase en recepción para acumular puntos."
};

const member = {
  id: "00000000-0000-4000-8000-00000000c123",
  name: "Verónica Navarro",
  pointsBalance: 1250,
  tier: "Gold",
  code: "K7M2Q",
  memberSince: 2026,
  erasedAt: null,
  clinic: { id: "clinic-1", name: "AURÉA", template }
};

/** Only the one call the assembler makes, so the test states its own dependency. */
const prismaReturning = (value: unknown) =>
  ({ member: { findUnique: vi.fn(async () => value) } }) as unknown as PrismaClient;

const assemblerFor = (value: unknown) =>
  new PrismaLoyaltyCardAssembler(prismaReturning(value), SECRET);

describe("PrismaLoyaltyCardAssembler", () => {
  it("builds a card the schema accepts", async () => {
    const card = await assemblerFor(member).assemble(member.id);

    expect(card.memberId).toBe(member.id);
    expect(card.member.fullName).toBe("Verónica Navarro");
    expect(card.clinic.name).toBe("AURÉA");
    expect(card.template.programName).toBe("Clinic Club");
    expect(card.redemptionCode).toMatch(/^[A-Z2-7]{26}$/);
  });

  it("reads the balance from pointsBalance, which is the source this class exists to replace", async () => {
    const card = await assemblerFor(member).assemble(member.id);

    expect(card.points).toBe(1250);
  });

  it("keeps the serial distinct from the redemption code", async () => {
    const card = await assemblerFor(member).assemble(member.id);

    expect(card.serialNumber).not.toBe(card.redemptionCode);
    expect(card.serialNumber).toContain(member.id);
  });

  it("omits a tier the member does not have rather than inventing one", async () => {
    const card = await assemblerFor({ ...member, tier: null }).assemble(member.id);

    expect(card.tier).toBeUndefined();
  });

  it("carries the member's own number onto the card", async () => {
    const card = await assemblerFor(member).assemble(member.id);

    expect(card.member.code).toBe("K7M2Q");
  });

  it("omits the code for a member the backfill has not reached", async () => {
    // Nullable in the database, optional on the card. The pass falls back to the serial
    // number rather than printing nothing — see apple-pass.fields.ts.
    const card = await assemblerFor({ ...member, code: null }).assemble(member.id);

    expect(card.member.code).toBeUndefined();
  });

  it("omits the join year when none was recorded", async () => {
    const card = await assemblerFor({ ...member, memberSince: null }).assemble(member.id);

    expect(card.member.memberSince).toBeUndefined();
  });

  describe("last clinic message", () => {
    const stored = {
      header: "Título",
      body: "cuerpo",
      sentAt: new Date("2026-10-27T10:00:00Z")
    };

    it("carries the member's stored message as `<d MMM> · <header>: <body>`", async () => {
      const card = await assemblerFor({ ...member, walletMessage: stored }).assemble(member.id);

      expect(card.message).toEqual({ text: "27 oct · Título: cuerpo" });
    });

    it("dates it in Europe/Madrid, so a message sent just before midnight UTC lands on the next day", async () => {
      const card = await assemblerFor({
        ...member,
        walletMessage: { ...stored, sentAt: new Date("2026-10-26T23:30:00Z") }
      }).assemble(member.id);

      expect(card.message?.text).toBe("27 oct · Título: cuerpo");
    });

    it.each([
      ["emoji that fit under the cap", "😀".repeat(100)],
      ["emoji that are truncated", "😀".repeat(150)],
      ["emoji cut mid-pair", `${"x".repeat(286)}😀😀`]
    ])("passes the real card schema with %s", async (_label, body) => {
      const card = await assemblerFor({
        ...member,
        walletMessage: { ...stored, header: "H", body }
      }).assemble(member.id);

      expect(card.message?.text.length).toBeLessThanOrEqual(300);
      expect(card.message?.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    });

    it("has no message when none was ever sent", async () => {
      expect((await assemblerFor(member).assemble(member.id)).message).toBeUndefined();
      expect(
        (await assemblerFor({ ...member, walletMessage: null }).assemble(member.id)).message
      ).toBeUndefined();
    });

    it("gives the same text on two assemblies, because the date comes from the stored sentAt", async () => {
      const assembler = assemblerFor({ ...member, walletMessage: stored });
      const first = await assembler.assemble(member.id);
      const second = await assembler.assemble(member.id);

      expect(second.message).toEqual(first.message);
    });

    it("reads the message in the same query as the member", async () => {
      const findUnique = vi.fn(async () => ({ ...member, walletMessage: stored }));
      const prisma = { member: { findUnique } } as unknown as PrismaClient;

      await new PrismaLoyaltyCardAssembler(prisma, SECRET).assemble(member.id);

      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({ walletMessage: true })
        })
      );
    });
  });

  it("refuses a member that does not exist", async () => {
    await expect(assemblerFor(null).assemble("nobody")).rejects.toBeInstanceOf(MemberNotFoundError);
  });

  it("treats an erased member as absent, so erasure is not undone by rendering a card", async () => {
    const erased = { ...member, erasedAt: new Date("2026-09-01T00:00:00Z") };

    await expect(assemblerFor(erased).assemble(member.id)).rejects.toBeInstanceOf(
      MemberNotFoundError
    );
  });

  it("does not echo the member id back to the caller", async () => {
    await expect(assemblerFor(null).assemble(member.id)).rejects.toSatisfy(
      (error: MemberNotFoundError) => error.expose === false
    );
  });

  it("fails loudly when the clinic has no template, naming the clinic", async () => {
    const withoutTemplate = { ...member, clinic: { ...member.clinic, template: null } };

    await expect(assemblerFor(withoutTemplate).assemble(member.id)).rejects.toSatisfy(
      (error: WalletConfigurationError) =>
        error instanceof WalletConfigurationError && error.message.includes("clinic-1")
    );
  });

  it("validates against the card schema rather than trusting the columns", async () => {
    // The database allows a name far longer than the pass field does.
    const longName = { ...member, name: "V".repeat(200) };

    await expect(assemblerFor(longName).assemble(member.id)).rejects.toBeInstanceOf(
      WalletConfigurationError
    );
  });

  it("treats empty template copy as absent, since the schema rejects an empty string", async () => {
    const blankCopy = {
      ...member,
      clinic: { ...member.clinic, template: { ...template, benefitsText: "", infoText: "" } }
    };

    const card = await assemblerFor(blankCopy).assemble(member.id);

    expect(card.template.benefitsText).toBeUndefined();
    expect(card.template.infoText).toBeUndefined();
  });
});

describe("PrismaLoyaltyCardAssembler for a clinic on an onboarding programme", () => {
  const programOutput = (() => {
    const result = run(catalogFixture as CatalogItem[], {
      ticket: null,
      freq: null,
      objective: "equilibrado",
      investment: "equilibrado",
      occupancy: "o2",
      members: "m3"
    });

    if (isEngineError(result)) throw new Error(result.error);

    return result;
  })();

  const onProgramme = (lifetimePoints: number) => ({
    ...member,
    tier: "Bronce",
    lifetimePoints,
    clinic: { ...member.clinic, onboardingPrograms: [{ output: programOutput }] }
  });

  it("tells the member how many POINTS to their next reward (ten per euro)", async () => {
    const card = await assemblerFor(onProgramme(15)).assemble(member.id);

    // The first reward is at 30 euros, so 15 of progress leaves 15 euros: 150 points.
    expect(card.reward?.description).toMatch(/te faltan 150 puntos$/);
  });

  it("names the reward itself", async () => {
    const card = await assemblerFor(onProgramme(0)).assemble(member.id);

    expect(card.reward?.description).toContain("Kit de minitallas");
  });

  it("shows how far through the step the member is", async () => {
    const card = await assemblerFor(onProgramme(15)).assemble(member.id);

    expect(card.reward?.progressPercent).toBe(50);
  });

  it("moves to the next reward once one is earned", async () => {
    const before = await assemblerFor(onProgramme(29)).assemble(member.id);
    const after = await assemblerFor(onProgramme(30)).assemble(member.id);

    expect(before.reward?.description).not.toBe(after.reward?.description);
  });

  it("keeps the description inside the pass's 120 characters, and the distance with it", async () => {
    const long = {
      ...onProgramme(0),
      clinic: {
        ...member.clinic,
        onboardingPrograms: [
          {
            output: {
              ...programOutput,
              lad: {
                ...programOutput.lad,
                ms: programOutput.lad.ms.map((m) => (m.n === 1 ? { ...m } : m))
              },
              chosen: programOutput.chosen.map((c) =>
                c.m.n === 1
                  ? {
                      ...c,
                      o: {
                        ...c.o,
                        items: [{ ...c.o.items[0], name: "Un nombre larguísimo ".repeat(12) }]
                      }
                    }
                  : c
              )
            }
          }
        ]
      }
    };
    const card = await assemblerFor(long).assemble(member.id);

    expect(card.reward!.description.length).toBeLessThanOrEqual(120);
    // The part the member acts on survives the shortening.
    expect(card.reward!.description).toMatch(/te faltan 300 puntos$/);
    expect(card.reward!.description).toContain("…");
  });

  it("ignores the template's own ladder, which the programme replaces", async () => {
    const withLegacy = {
      ...onProgramme(15),
      tier: "Bronce",
      clinic: {
        ...member.clinic,
        template: { ...template, tierRewards: [{ name: "Bronce", rewardText: "TEXTO ANTIGUO" }] },
        onboardingPrograms: [{ output: programOutput }]
      }
    };
    const card = await assemblerFor(withLegacy).assemble(member.id);

    expect(card.reward?.description).not.toContain("TEXTO ANTIGUO");
  });

  it("leaves a clinic with no programme exactly as it was", async () => {
    // The whole reason the programme is looked up optionally: nothing changes for anyone
    // who has not published one.
    const none = { ...member, clinic: { ...member.clinic, onboardingPrograms: [] } };
    const withEmpty = await assemblerFor(none).assemble(member.id);
    const original = await assemblerFor(member).assemble(member.id);

    // Identical to the card built before programmes existed, whether the relation is empty
    // or absent altogether.
    expect(withEmpty).toEqual(original);
  });
});
