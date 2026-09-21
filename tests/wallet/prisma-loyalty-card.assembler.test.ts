import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MemberNotFoundError } from "../../src/common/errors/membership.errors";
import { WalletConfigurationError } from "../../src/common/errors/wallet.errors";
import { PrismaLoyaltyCardAssembler } from "../../src/wallet/prisma-loyalty-card.assembler";

const SECRET = "a-server-secret-not-a-member-attribute";

const template = {
  programName: "Clinic Club",
  hexBackgroundColor: "#f1dccd",
  pointsLabel: "Saldo Beauty",
  tierLabel: "Nivel",
  benefitsText: "Acceso exclusivo a tratamientos, eventos y ofertas de socia.",
  infoText: "Presenta este pase en recepción para acumular puntos."
};

const member = {
  id: "00000000-0000-4000-8000-00000000c123",
  name: "Verónica Navarro",
  pointsBalance: 1250,
  tier: "Gold",
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

  it("omits the join year when none was recorded", async () => {
    const card = await assemblerFor({ ...member, memberSince: null }).assemble(member.id);

    expect(card.member.memberSince).toBeUndefined();
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
