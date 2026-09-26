import { PrismaClient, type Clinic } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { signUpMember } from "../../src/modules/members/membership.service";
import { membershipSignupSchema } from "../../src/modules/members/membership.schema";

/**
 * Everything in this file shares one database, so it lives in a single file: two files
 * truncating Member concurrently would interfere.
 */
const db = new PrismaClient();

const input = (over: Partial<{ name: string; phone: string; consentMarketing: boolean }> = {}) =>
  membershipSignupSchema.parse({
    name: "Verónica Navarro",
    phone: "612345678",
    consentMarketing: false,
    ...over
  });

let aurea: Clinic;
let lumiere: Clinic;

beforeAll(async () => {
  aurea = await db.clinic.upsert({
    where: { slug: "test-aurea" },
    update: {},
    create: {
      slug: "test-aurea",
      name: "AURÉA",
      addressLine: "Calle de Serrano 21",
      pincode: "28001"
    }
  });
  lumiere = await db.clinic.upsert({
    where: { slug: "test-lumiere" },
    update: {},
    create: {
      slug: "test-lumiere",
      name: "LUMIÈRE",
      addressLine: "Avinguda Diagonal 440",
      pincode: "08037"
    }
  });
});

beforeEach(async () => {
  await db.member.deleteMany({ where: { clinicId: { in: [aurea.id, lumiere.id] } } });
});

afterAll(async () => {
  await db.member.deleteMany({ where: { clinicId: { in: [aurea.id, lumiere.id] } } });
  await db.clinic.deleteMany({ where: { slug: { in: ["test-aurea", "test-lumiere"] } } });
  await db.$disconnect();
});

describe("sign-up against a real database", () => {
  it("collapses every spelling of one number onto a single member", async () => {
    for (const phone of ["612345678", "+34 612 34 56 78", "0034612345678", "(+34) 612-345-678"]) {
      await signUpMember(db, aurea, input({ phone, name: "Otra Persona" }), "qr_signup");
    }

    const members = await db.member.findMany({ where: { clinicId: aurea.id } });

    expect(members).toHaveLength(1);
    expect(members[0].signupCount).toBe(4);
    // The name from the first submission survives: a re-scan must not rename a member.
    expect(members[0].name).toBe("Otra Persona");
    expect(members[0].phone).toBe("+34612345678");
  });

  it("lets the same person join a second clinic independently", async () => {
    await signUpMember(db, aurea, input(), "qr_signup");
    await signUpMember(db, lumiere, input(), "qr_signup");

    // Scoped to this file's clinics: the seeded demo clinics may hold their own rows.
    expect(
      await db.member.count({
        where: { phone: "+34612345678", clinicId: { in: [aurea.id, lumiere.id] } }
      })
    ).toBe(2);
  });

  it("survives two simultaneous submissions of the same number", async () => {
    // The real time-of-check race: both callers see no existing row and both insert.
    const results = await Promise.all([
      signUpMember(db, aurea, input(), "qr_signup"),
      signUpMember(db, aurea, input(), "qr_signup")
    ]);

    expect(await db.member.count({ where: { clinicId: aurea.id } })).toBe(1);
    // Both callers succeed — one created the row, the other recovered from the conflict.
    expect(results.map((r) => r.created).sort()).toEqual([false, true]);

    const member = await db.member.findFirstOrThrow({ where: { clinicId: aurea.id } });
    expect(member.signupCount).toBe(2);
  });

  it("lets an erased member register again, which the tombstone is for", async () => {
    await signUpMember(db, aurea, input(), "qr_signup");
    const original = await db.member.findFirstOrThrow({ where: { clinicId: aurea.id } });

    await db.member.update({
      where: { id: original.id },
      data: {
        name: "[erased]",
        phoneRaw: null,
        phone: `erased:${crypto.randomUUID()}`,
        erasedAt: new Date()
      }
    });

    const result = await signUpMember(db, aurea, input(), "qr_signup");

    // A real id, not just created:true — the route mints a pass claim from it, so an
    // erased member registering again must get a claim like anyone else.
    expect(result.created).toBe(true);
    expect(result.memberId).toEqual(expect.any(String));
    expect(await db.member.count({ where: { clinicId: aurea.id } })).toBe(2);
  });
});

describe("database constraints", () => {
  it("rejects a phone that was never normalized", async () => {
    // The unique index only detects duplicates if every writer agrees on the canonical
    // form, so the database enforces the shape rather than trusting the service.
    await expect(
      db.member.create({
        data: {
          clinicId: aurea.id,
          name: "Raw",
          phone: "612 34 56 78",
          memberSince: 2026,
          consentMarketing: false,
          consentSource: "qr_signup",
          privacyPolicyVersion: "v1"
        }
      })
    ).rejects.toThrow();
  });

  it("rejects a landline, which could never receive the programme's SMS", async () => {
    await expect(
      db.member.create({
        data: {
          clinicId: aurea.id,
          name: "Fija",
          phone: "+34912345678",
          memberSince: 2026,
          consentMarketing: false,
          consentSource: "qr_signup",
          privacyPolicyVersion: "v1"
        }
      })
    ).rejects.toThrow();
  });
});

describe("seeded clinics", () => {
  it("are present with a template, so a fresh environment can serve a QR code", async () => {
    // A clinic without a template cannot render the branded page at all, so seeding one
    // without the other would leave a slug that 404s.
    const seeded = await db.clinic.findMany({
      where: { slug: { in: ["aurea", "lumiere"] } },
      include: { template: true }
    });

    expect(seeded.map((c) => c.slug).sort()).toEqual(["aurea", "lumiere"]);
    for (const clinic of seeded) {
      expect(clinic.template, clinic.slug).not.toBeNull();
      expect(clinic.template?.hexBackgroundColor, clinic.slug).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
