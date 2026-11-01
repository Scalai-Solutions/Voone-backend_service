import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MemberNotFoundError } from "../../src/common/errors/membership.errors";
import { WalletConfigurationError } from "../../src/common/errors/wallet.errors";
import { run } from "../../src/modules/onboarding/engine";
import type { CatalogItem } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import catalogFixture from "../onboarding/reference/sapphira.catalogo.json";
import { presentProgram } from "../../src/modules/onboarding/presentation";
import { loyaltyCardSchema } from "../../src/wallet/engine/loyalty-card";
import { aureaGoldPass } from "../fixtures/loyalty-card.fixture";
import { tierBenefitsText } from "../../src/wallet/engine/tier-benefits-text";
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

/** A programme centre also asks whether the member was referred; nobody was. */
const NO_REFERRAL = {
  referral: { findUnique: vi.fn(async () => null) },
  paidVisit: { findFirst: vi.fn(async () => null) }
};

/** Only the one call the assembler makes, so the test states its own dependency. */
const prismaReturning = (value: unknown) =>
  ({ member: { findUnique: vi.fn(async () => value) }, ...NO_REFERRAL }) as unknown as PrismaClient;

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
      const prisma = { member: { findUnique }, ...NO_REFERRAL } as unknown as PrismaClient;

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

  it("reads the newest ACTIVO programme, so two of them can never make the card alternate", async () => {
    const findUnique = vi.fn(async () => onProgramme(15));
    const prisma = { member: { findUnique }, ...NO_REFERRAL } as unknown as PrismaClient;

    await new PrismaLoyaltyCardAssembler(prisma, "x".repeat(32)).assemble(member.id);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          clinic: expect.objectContaining({
            include: expect.objectContaining({
              onboardingPrograms: expect.objectContaining({
                orderBy: { version: "desc" },
                take: 1
              })
            })
          })
        })
      })
    );
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

describe("PrismaLoyaltyCardAssembler: overlong clinic texts", () => {
  const withTexts = (benefitsText: string, infoText: string) => ({
    ...member,
    clinic: { ...member.clinic, template: { ...template, benefitsText, infoText } }
  });

  it("clips a 900-character text instead of failing every card of the clinic", async () => {
    const value = withTexts("b".repeat(900), "i".repeat(900));

    const card = await assemblerFor(value).assemble(member.id);

    expect(card.template.benefitsText).toBe(`${"b".repeat(499)}…`);
    expect(card.template.infoText).toBe(`${"i".repeat(499)}…`);
    expect(loyaltyCardSchema.safeParse(card).success).toBe(true);
  });

  it("leaves a text of exactly 500 characters unchanged", async () => {
    const exact = "x".repeat(500);

    const card = await assemblerFor(withTexts(exact, exact)).assemble(member.id);

    expect(card.template.benefitsText).toBe(exact);
    expect(card.template.infoText).toBe(exact);
  });

  it("never splits an emoji surrogate pair and still passes the card schema", async () => {
    // The 499-unit budget would end between the two halves of an emoji.
    const text = `${"a".repeat(498)}${"😀".repeat(200)}`;

    const card = await assemblerFor(withTexts(text, text)).assemble(member.id);

    expect(card.template.benefitsText).toBe(`${"a".repeat(498)}…`);
    expect(card.template.benefitsText).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(loyaltyCardSchema.safeParse(card).success).toBe(true);
  });

  it("clips an emoji-heavy text inside the card's own unit", async () => {
    const text = "😀".repeat(400);

    const card = await assemblerFor(withTexts(text, text)).assemble(member.id);

    expect(card.template.benefitsText).toBe(`${"😀".repeat(249)}…`);
    expect(loyaltyCardSchema.safeParse(card).success).toBe(true);
  });
});

describe("PrismaLoyaltyCardAssembler: redeemable rewards", () => {
  const NOW = new Date("2026-10-27T10:00:00Z");
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

  const reward = (
    title: string,
    expiresAt: string,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    title,
    kind: "PREMIO",
    issuedAt: new Date("2026-10-01T09:00:00Z"),
    id: `id-${title}`,
    redeemedAt: null,
    expiresAt: new Date(expiresAt),
    ...extra
  });

  const programmeMember = (rewards?: Array<Record<string, unknown>>) => ({
    ...member,
    tier: "Bronce",
    lifetimePoints: 175,
    clinic: { ...member.clinic, onboardingPrograms: [{ output: programOutput }] },
    ...(rewards ? { rewards } : {})
  });

  /**
   * A stand-in for the database that honours the rewards `where` and `take` the assembler asks for,
   * so "the redeemed one is dropped" is proved by the query it sends, not by what the test returns.
   */
  const assembler = (value: { rewards?: Array<Record<string, unknown>> }) => {
    const findUnique = vi.fn(
      async (args: {
        include: {
          rewards: {
            where: { redeemedAt: null; expiresAt: { gt: Date } };
            orderBy: Array<Record<string, "asc">>;
            take: number;
          };
        };
      }) => {
        const { where, orderBy, take } = args.include.rewards;
        const compare = (a: Record<string, unknown>, b: Record<string, unknown>): number => {
          for (const clause of orderBy) {
            const [field] = Object.keys(clause);
            const x =
              a[field] instanceof Date ? (a[field] as Date).getTime() : (a[field] as string);
            const y =
              b[field] instanceof Date ? (b[field] as Date).getTime() : (b[field] as string);

            if (x < y) return -1;
            if (x > y) return 1;
          }

          return 0;
        };

        return {
          ...value,
          rewards: (value.rewards ?? [])
            .filter(
              (r) =>
                r.redeemedAt === where.redeemedAt &&
                (r.expiresAt as Date).getTime() > where.expiresAt.gt.getTime()
            )
            .sort(compare)
            .slice(0, take)
        };
      }
    );

    return new PrismaLoyaltyCardAssembler(
      { member: { findUnique }, ...NO_REFERRAL } as unknown as PrismaClient,
      SECRET,
      () => NOW
    );
  };

  it("lists the two available rewards ordered by expiry, dropping the redeemed and the expired", async () => {
    const card = await assembler(
      programmeMember([
        reward("Segundo", "2026-12-20T10:00:00Z"),
        reward("Canjeado", "2026-11-30T10:00:00Z", {
          redeemedAt: new Date("2026-10-20T10:00:00Z")
        }),
        reward("Caducado", "2026-10-26T10:00:00Z"),
        reward("Primero", "2026-11-15T10:00:00Z")
      ])
    ).assemble(member.id);

    expect(card.rewards).toEqual({
      available: [
        { title: "Primero", expiresAt: "2026-11-15T10:00:00.000Z" },
        { title: "Segundo", expiresAt: "2026-12-20T10:00:00.000Z" }
      ]
    });
  });

  it("asks the database for available rewards only, in a stable order, in the member's own query", async () => {
    const findUnique = vi.fn(async () => programmeMember([]));
    const prisma = { member: { findUnique }, ...NO_REFERRAL } as unknown as PrismaClient;

    await new PrismaLoyaltyCardAssembler(prisma, SECRET, () => NOW).assemble(member.id);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          rewards: {
            where: { redeemedAt: null, expiresAt: { gt: NOW } },
            // Rewards issued by one visit share an expiry; the tie-breakers keep two builds equal.
            orderBy: [{ expiresAt: "asc" }, { issuedAt: "asc" }, { id: "asc" }],
            take: 20,
            select: { title: true, kind: true, detail: true, expiresAt: true }
          }
        })
      })
    );
  });

  it("breaks an expiry tie by issue time and then id, so two builds are byte-equal", async () => {
    const same = "2026-12-01T10:00:00Z";
    const rows = [
      reward("C", same, { id: "z", issuedAt: new Date("2026-10-02T00:00:00Z") }),
      reward("B", same, { id: "b", issuedAt: new Date("2026-10-01T00:00:00Z") }),
      reward("A", same, { id: "a", issuedAt: new Date("2026-10-01T00:00:00Z") })
    ];
    const first = await assembler(programmeMember(rows)).assemble(member.id);
    const second = await assembler(programmeMember([...rows].reverse())).assemble(member.id);

    expect(first.rewards?.available.map((r) => r.title)).toEqual(["A", "B", "C"]);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("carries an empty list, not nothing, for a programme member with no rewards", async () => {
    expect((await assembler(programmeMember([])).assemble(member.id)).rewards).toEqual({
      available: []
    });
    expect((await assembler(programmeMember()).assemble(member.id)).rewards).toEqual({
      available: []
    });
  });

  it("carries no rewards at all for a clinic with no programme", async () => {
    const none = {
      ...member,
      clinic: { ...member.clinic, onboardingPrograms: [] },
      rewards: [reward("Premio", "2026-12-01T10:00:00Z")]
    };

    expect((await assembler(none).assemble(member.id)).rewards).toBeUndefined();
  });

  it("passes the real card schema, shortening a title the pass cannot hold", async () => {
    const card = await assembler(
      programmeMember([reward("T".repeat(300), "2026-12-01T10:00:00Z")])
    ).assemble(member.id);

    expect(card.rewards?.available[0].title).toHaveLength(120);
    expect(loyaltyCardSchema.safeParse(card).success).toBe(true);
  });

  it("rejects more than 20 rewards in the schema", () => {
    const card = {
      memberId: "m",
      serialNumber: "s",
      redemptionCode: "MFRGGZDFMZTWQ2LKNNWG23Q",
      clinic: { name: "C" },
      member: { fullName: "N" },
      points: 0,
      rewards: {
        available: Array.from({ length: 21 }, () => ({
          title: "x",
          expiresAt: "2026-12-01T10:00:00.000Z"
        }))
      },
      template: {
        programName: "P",
        backgroundColor: "#ffffff",
        pointsLabel: "p",
        tierLabel: "t"
      }
    };

    expect(loyaltyCardSchema.safeParse(card).success).toBe(false);
  });

  it("leaves out the double-points perk, which cannot be redeemed by hand", async () => {
    const card = await assembler(
      programmeMember([
        reward("Puntos dobles", "2026-11-01T10:00:00Z", {
          kind: "VENTAJA",
          detail: { perk: "doble" }
        }),
        reward("Sorpresa", "2026-11-02T10:00:00Z", {
          kind: "VENTAJA",
          detail: { perk: "sorpresa" }
        }),
        reward("Premio", "2026-11-03T10:00:00Z", { detail: { items: [] } })
      ])
    ).assemble(member.id);

    expect(card.rewards?.available.map((r) => r.title)).toEqual(["Sorpresa", "Premio"]);
  });

  it("names a blank title Regalo instead of failing the whole card", async () => {
    const card = await assembler(
      programmeMember([
        reward("", "2026-11-01T10:00:00Z"),
        reward("   ", "2026-11-02T10:00:00Z", { id: "x" })
      ])
    ).assemble(member.id);

    expect(card.rewards?.available.map((r) => r.title)).toEqual(["Regalo", "Regalo"]);
  });

  it("cuts a long title on a code point, never in the middle of an emoji", async () => {
    const card = await assembler(
      programmeMember([reward(`${"x".repeat(119)}😀😀`, "2026-11-01T10:00:00Z")])
    ).assemble(member.id);
    const [{ title }] = card.rewards!.available;

    expect(title.length).toBeLessThanOrEqual(120);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(title).toBe("x".repeat(119));
    expect(loyaltyCardSchema.safeParse(card).success).toBe(true);
  });
});

describe("PrismaLoyaltyCardAssembler: the member's tier benefits", () => {
  const output = (() => {
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

  const programme = (programOutput: unknown) => ({
    clinic: { ...member.clinic, onboardingPrograms: [{ output: programOutput }] }
  });
  const memberOf = (tier: string | null, programOutput: unknown = output) => ({
    ...member,
    tier,
    lifetimePoints: 0,
    ...programme(programOutput)
  });
  const presented = (label: string, programOutput: unknown = output) =>
    presentProgram(programOutput as never).tiers.find((t) => t.label === label)?.benefits ?? [];

  it("gives the benefits of the member's own tier as the programme defines them", async () => {
    const card = await assemblerFor(memberOf("Plata")).assemble(member.id);

    expect(card.tierBenefits?.tier).toBe("Plata");
    expect(card.tierBenefits?.lines).toEqual(presented("Plata"));
    expect(card.tierBenefits?.lines.length).toBeGreaterThan(0);
  });

  it("includes the benefits the clinic wrote itself", async () => {
    const custom = { ...output, customBenefits: { plata: ["Masaje de bienvenida"] } };
    const card = await assemblerFor(memberOf("Plata", custom)).assemble(member.id);

    expect(card.tierBenefits?.lines).toEqual(presented("Plata", custom));
    expect(card.tierBenefits?.lines).toContain("Masaje de bienvenida");
  });

  it("shows an edited generated line and leaves out a hidden one", async () => {
    const plain = await assemblerFor(memberOf("Plata")).assemble(member.id);
    const overridden = {
      ...output,
      benefitOverrides: {
        plata: { priority: { text: "Te avisamos antes si hay hueco" }, discount: { hidden: true } }
      }
    };
    const card = await assemblerFor(memberOf("Plata", overridden)).assemble(member.id);
    const lines = card.tierBenefits!.lines;

    expect(lines).toEqual(presented("Plata", overridden));
    expect(lines).toContain("Te avisamos antes si hay hueco");
    expect(lines.some((l) => l.startsWith("Prioridad en huecos"))).toBe(false);
    expect(lines.some((l) => l.startsWith("Descuento del 3%"))).toBe(false);
    expect(plain.tierBenefits!.lines.some((l) => l.startsWith("Descuento del 3%"))).toBe(true);
    expect(lines).toHaveLength(plain.tierBenefits!.lines.length - 1);
    expect(loyaltyCardSchema.safeParse(card).success).toBe(true);
  });

  it("has no tier benefits for a stored programme that leaves the tier no visible line (the API refuses to store one), so Apple shows the template text and Google nothing", async () => {
    const hideAll = {
      ...output,
      benefitOverrides: {
        bronce: Object.fromEntries(
          presentProgram(output)
            .tiers.find((t) => t.key === "bronce")!
            .benefitLines.map((l) => [l.key, { hidden: true }])
        )
      }
    };
    const card = await assemblerFor(memberOf("Bronce", hideAll)).assemble(member.id);

    expect(card.tierBenefits).toBeUndefined();
    // The one field both wallets read: undefined, so Apple's back field falls back to the
    // template's benefits text and Google's per-member module is removed.
    expect(tierBenefitsText(card)).toBeUndefined();
  });

  it("gives a member of another tier that tier's benefits, not Plata's", async () => {
    const bronce = await assemblerFor(memberOf("Bronce")).assemble(member.id);
    const oro = await assemblerFor(memberOf("Oro")).assemble(member.id);

    expect(bronce.tierBenefits?.tier).toBe("Bronce");
    expect(bronce.tierBenefits?.lines).toEqual(presented("Bronce"));
    expect(oro.tierBenefits?.tier).toBe("Oro");
    expect(oro.tierBenefits?.lines).toEqual(presented("Oro"));
    expect(bronce.tierBenefits?.lines).not.toEqual(oro.tierBenefits?.lines);
  });

  it("has none for a clinic with no programme, which keeps its hand-typed text", async () => {
    const card = await assemblerFor({
      ...member,
      clinic: { ...member.clinic, onboardingPrograms: [] }
    }).assemble(member.id);

    expect(card.tierBenefits).toBeUndefined();
    expect(card.template.benefitsText).toBe(template.benefitsText);
  });

  it("has none when the member's tier is not in the programme, or the member has no tier", async () => {
    expect((await assemblerFor(memberOf("Gold")).assemble(member.id)).tierBenefits).toBeUndefined();
    expect((await assemblerFor(memberOf(null)).assemble(member.id)).tierBenefits).toBeUndefined();
  });

  it("has none, rather than failing the card, when the programme cannot be presented", async () => {
    const card = await assemblerFor(memberOf("Plata", { ...output, gifts: undefined })).assemble(
      member.id
    );

    expect(card.tierBenefits).toBeUndefined();
    expect(card.template.benefitsText).toBe(template.benefitsText);
  });

  it("clips a long list inside 500 characters and says how many it left out", async () => {
    const custom = {
      ...output,
      customBenefits: {
        diamante: Array.from({ length: 6 }, (_, i) => `${i + 1} ${"Beneficio largo ".repeat(5)}`)
      }
    };
    const card = await assemblerFor(memberOf("Diamante", custom)).assemble(member.id);
    const all = presented("Diamante", custom);
    const lines = card.tierBenefits?.lines ?? [];
    const shown = lines.length - 1;

    expect(all.length).toBeGreaterThan(shown);
    expect(lines.at(-1)).toBe(`… y ${all.length - shown} más`);
    expect(lines.slice(0, shown)).toEqual(all.slice(0, shown).map((l) => l.trim()));
    expect(tierBenefitsText(card)?.length).toBeLessThanOrEqual(500);
    expect(lines.length).toBeLessThanOrEqual(12);
  });

  it("builds a card the schema accepts, byte-equal on a second build", async () => {
    const first = await assemblerFor(memberOf("Plata")).assemble(member.id);
    const second = await assemblerFor(memberOf("Plata")).assemble(member.id);

    expect(loyaltyCardSchema.safeParse(first).success).toBe(true);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("does not ask the database for anything more", async () => {
    const findUnique = vi.fn(async () => memberOf("Plata"));

    await new PrismaLoyaltyCardAssembler(
      { member: { findUnique }, ...NO_REFERRAL } as unknown as PrismaClient,
      SECRET
    ).assemble(member.id);

    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("PrismaLoyaltyCardAssembler: the pending boost (x2)", () => {
  const NOW = new Date("2026-10-27T10:00:00Z");
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

  const perk = (expiresAt: string, extra: Record<string, unknown> = {}) => ({
    title: "Puntos dobles en tu próxima visita",
    kind: "VENTAJA",
    detail: { perk: "doble" },
    issuedAt: new Date("2026-09-01T09:00:00Z"),
    expiresAt: new Date(expiresAt),
    ...extra
  });

  const programmeMember = (extra: Record<string, unknown> = {}) => ({
    ...member,
    tier: "Bronce",
    lifetimePoints: 175,
    clinic: { ...member.clinic, onboardingPrograms: [{ output: programOutput }] },
    rewards: [],
    referredBy: null,
    paidVisits: [],
    ...extra
  });

  const lookups = { referral: vi.fn(), paidVisit: vi.fn() };
  const prismaFor = (value: unknown) => {
    const row = value as { referredBy?: { id: string } | null; paidVisits?: Array<{ id: string }> };

    lookups.referral.mockReset().mockImplementation(async () => row.referredBy ?? null);
    lookups.paidVisit.mockReset().mockImplementation(async () => row.paidVisits?.[0] ?? null);

    return {
      member: { findUnique: vi.fn(async () => value) },
      referral: { findUnique: lookups.referral },
      paidVisit: { findFirst: lookups.paidVisit }
    } as unknown as PrismaClient;
  };

  const build = (value: unknown) =>
    new PrismaLoyaltyCardAssembler(prismaFor(value), SECRET, () => NOW).assemble(member.id);

  it("costs a clinic with no programme no extra query, and asks the paid visit only of a referred member", async () => {
    const findUnique = vi.fn(async () => ({ ...member }));

    await new PrismaLoyaltyCardAssembler(
      { member: { findUnique } } as unknown as PrismaClient,
      SECRET,
      () => NOW
    ).assemble(member.id);

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(findUnique.mock.calls[0])).not.toMatch(/referredBy|paidVisits/);

    await build(programmeMember());

    expect(lookups.referral).toHaveBeenCalledTimes(1);
    expect(lookups.paidVisit).not.toHaveBeenCalled();

    await build(programmeMember({ referredBy: { id: "r1" } }));

    expect(lookups.paidVisit).toHaveBeenCalledTimes(1);
  });

  it("shows a waiting x2 perk with the date it lapses", async () => {
    const card = await build(programmeMember({ rewards: [perk("2026-11-30T10:00:00Z")] }));

    expect(card.boost).toEqual({ kind: "perk", until: "2026-11-30T10:00:00.000Z" });
    // The perk is still not offered as a gift to present.
    expect(card.rewards?.available).toEqual([]);
  });

  it("shows a referred member with no payment yet, with no end date", async () => {
    const card = await build(programmeMember({ referredBy: { id: "r1" } }));

    expect(card.boost).toEqual({ kind: "referral" });
    expect(card.boost).not.toHaveProperty("until");
  });

  it("shows nothing once the referred member has paid", async () => {
    const card = await build(
      programmeMember({ referredBy: { id: "r1" }, paidVisits: [{ id: "v" }] })
    );

    expect(card.boost).toBeUndefined();
  });

  it("names the referral when both are waiting: the same call as the visit credit makes", async () => {
    const card = await build(
      programmeMember({ referredBy: { id: "r1" }, rewards: [perk("2026-11-30T10:00:00Z")] })
    );

    expect(card.boost).toEqual({ kind: "referral" });
  });

  it("ignores a perk that has lapsed", async () => {
    const card = await build(programmeMember({ rewards: [perk("2026-10-27T10:00:00Z")] }));

    expect(card.boost).toBeUndefined();
  });

  it("has no boost for a clinic with no programme", async () => {
    const card = await build({ ...member, referredBy: { id: "r1" }, paidVisits: [] });

    expect(card.boost).toBeUndefined();
  });

  it("finds the perk even when twenty other rewards fill the card's list", async () => {
    const base = prismaFor(programmeMember());
    const full = Array.from({ length: 20 }, (_, i) => ({
      title: `Premio ${i}`,
      kind: "PREMIO",
      detail: {},
      issuedAt: new Date("2026-09-01T09:00:00Z"),
      expiresAt: new Date(`2026-11-${String(i + 1).padStart(2, "0")}T10:00:00Z`)
    }));
    const memberRewardFindFirst = vi.fn(async () => ({
      id: "p",
      expiresAt: new Date("2026-12-20T10:00:00Z")
    }));
    const card = await new PrismaLoyaltyCardAssembler(
      {
        ...base,
        member: { findUnique: vi.fn(async () => programmeMember({ rewards: full })) },
        memberReward: { findFirst: memberRewardFindFirst }
      } as unknown as PrismaClient,
      SECRET,
      () => NOW
    ).assemble(member.id);

    expect(card.boost).toEqual({ kind: "perk", until: "2026-12-20T10:00:00.000Z" });
    expect(memberRewardFindFirst).toHaveBeenCalledTimes(1);
  });

  it("is byte-equal on a second build and passes the card schema", async () => {
    const value = programmeMember({ rewards: [perk("2026-11-30T10:00:00Z")] });
    const first = await build(value);
    const second = await build(value);

    expect(loyaltyCardSchema.safeParse(first).success).toBe(true);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("rejects an unknown kind in the schema", () => {
    const card = { ...aureaGoldPass, boost: { kind: "other" } };

    expect(loyaltyCardSchema.safeParse(card).success).toBe(false);
  });
});

describe("PrismaLoyaltyCardAssembler: the referral share", () => {
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

  const programmeMember = (clinicExtra: Record<string, unknown> = { slug: "clinica-aurea" }) => ({
    ...member,
    tier: "Bronce",
    lifetimePoints: 175,
    clinic: {
      ...member.clinic,
      ...clinicExtra,
      onboardingPrograms: [{ output: programOutput }]
    }
  });

  const build = (value: unknown, base: string | undefined = "https://voone.app") =>
    new PrismaLoyaltyCardAssembler(
      {
        member: { findUnique: vi.fn(async () => value) },
        ...NO_REFERRAL
      } as unknown as PrismaClient,
      SECRET,
      undefined,
      base
    ).assemble(member.id);

  it("carries the member's own code and the signup link of their clinic", async () => {
    const card = await build(programmeMember());

    expect(card.referral).toEqual({
      code: "K7M2Q",
      url: "https://voone.app/alta/clinica-aurea?ref=K7M2Q"
    });
  });

  it("does not double the slash of a base that ends with one, and escapes the slug", async () => {
    const card = await build(programmeMember({ slug: "clínica aurea" }), "https://voone.app/");

    expect(card.referral?.url).toBe("https://voone.app/alta/cl%C3%ADnica%20aurea?ref=K7M2Q");
  });

  it.each([
    ["a blank base URL", programmeMember(), "  "],
    ["no clinic slug", programmeMember({}), "https://voone.app"],
    ["an empty slug", programmeMember({ slug: "" }), "https://voone.app"]
  ])("omits the referral entirely with %s", async (_label, value, base) => {
    const card = await build(value, base);

    expect(card).not.toHaveProperty("referral");
  });

  it("omits it when the assembler was built with no base URL at all", async () => {
    const card = await new PrismaLoyaltyCardAssembler(
      {
        member: { findUnique: vi.fn(async () => programmeMember()) },
        ...NO_REFERRAL
      } as unknown as PrismaClient,
      SECRET
    ).assemble(member.id);

    expect(card).not.toHaveProperty("referral");
  });

  it("omits it for a member with no code, and for a clinic with no programme", async () => {
    expect(await build({ ...programmeMember(), code: null })).not.toHaveProperty("referral");
    expect(
      await build({ ...member, clinic: { ...member.clinic, slug: "clinica-aurea" } })
    ).not.toHaveProperty("referral");
  });

  it("is byte-equal on a second build and passes the card schema", async () => {
    const first = await build(programmeMember());
    const second = await build(programmeMember());

    expect(loyaltyCardSchema.safeParse(first).success).toBe(true);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("rejects a referral with a code that is not five characters, or a url that is not a url", () => {
    expect(
      loyaltyCardSchema.safeParse({
        ...aureaGoldPass,
        referral: { code: "AB", url: "https://voone.app/alta/x?ref=AB" }
      }).success
    ).toBe(false);
    expect(
      loyaltyCardSchema.safeParse({
        ...aureaGoldPass,
        referral: { code: "K7M2Q", url: "not a url" }
      }).success
    ).toBe(false);
  });
});
