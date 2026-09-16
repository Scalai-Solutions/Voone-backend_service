import { Prisma, type Clinic, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { signUpMember } from "../../src/modules/members/membership.service";

const AUREA = {
  id: "c1",
  slug: "aurea",
  name: "AURÉA",
  addressLine: "Calle de Serrano 21",
  pincode: "28001",
  privacyPolicyVersion: "v3",
  isActive: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z")
} satisfies Clinic;

const INPUT = {
  name: "Verónica Navarro",
  email: undefined,
  phone: "+34612345678",
  phoneRaw: "612 34 56 78",
  phoneRegionAssumed: true,
  consentMarketing: true,
  // Omitted by the public form, which is what the undefined represents. The service takes
  // the provenance as its own argument regardless, so this field never reaches the row.
  consentSource: undefined
};

const NOW = new Date("2026-09-11T10:00:00Z");

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: Prisma.prismaVersion.client,
    meta: { target: ["clinicId", "phone"] }
  });

const db = (member: Record<string, unknown>) => ({ member }) as unknown as PrismaClient;

describe("signUpMember", () => {
  it("stores the canonical submission against the clinic", async () => {
    const create = vi.fn().mockResolvedValue({});

    await expect(signUpMember(db({ create }), AUREA, INPUT, "qr_signup", NOW)).resolves.toEqual({
      created: true
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        clinicId: "c1",
        name: "Verónica Navarro",
        email: undefined,
        phone: "+34612345678",
        phoneRaw: "612 34 56 78",
        phoneRegionAssumed: true,
        normalizerVersion: 1,
        memberSince: 2026,
        consentMarketing: true,
        consentMarketingAt: NOW,
        consentSource: "qr_signup",
        // Snapshot of the notice the member was actually shown, taken from the clinic.
        privacyPolicyVersion: "v3",
        lastSignupAt: NOW
      }
    });
  });

  it("records no consent timestamp when marketing consent is declined", async () => {
    const create = vi.fn().mockResolvedValue({});

    await signUpMember(
      db({ create }),
      AUREA,
      { ...INPUT, consentMarketing: false },
      "qr_signup",
      NOW
    );

    expect(create.mock.calls[0][0].data).toMatchObject({
      consentMarketing: false,
      consentMarketingAt: null
    });
  });

  describe("when the number is already a member of this clinic", () => {
    it("counts the re-scan instead of failing", async () => {
      const create = vi.fn().mockRejectedValue(uniqueViolation());
      const update = vi.fn().mockResolvedValue({});

      await expect(
        signUpMember(db({ create, update }), AUREA, INPUT, "qr_signup", NOW)
      ).resolves.toEqual({
        created: false
      });

      expect(update).toHaveBeenCalledWith({
        where: { clinicId_phone: { clinicId: "c1", phone: "+34612345678" } },
        data: { signupCount: { increment: 1 }, lastSignupAt: NOW }
      });
    });

    it("never rewrites the stored name", async () => {
      // Otherwise anyone who knows a phone number could rename a real member, and that
      // name is what appears on the pass they show at reception.
      const create = vi.fn().mockRejectedValue(uniqueViolation());
      const update = vi.fn().mockResolvedValue({});

      await signUpMember(
        db({ create, update }),
        AUREA,
        { ...INPUT, name: "Otra" },
        "qr_signup",
        NOW
      );

      expect(update.mock.calls[0][0].data).not.toHaveProperty("name");
      expect(update.mock.calls[0][0].data).not.toHaveProperty("consentMarketing");
      expect(update.mock.calls[0][0].data).not.toHaveProperty("phoneRaw");
    });
  });

  it("rethrows when the blocking row vanished, rather than retrying forever", async () => {
    // Lost a race with a concurrent erasure. A retry loop here would be an unbounded
    // spin under adversarial load on an unauthenticated endpoint.
    const violation = uniqueViolation();
    const create = vi.fn().mockRejectedValue(violation);
    const update = vi.fn().mockRejectedValue(new Error("record not found"));

    await expect(signUpMember(db({ create, update }), AUREA, INPUT, "qr_signup", NOW)).rejects.toBe(
      violation
    );
    expect(create).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
  });

  it("does not swallow other database failures", async () => {
    const outage = new Prisma.PrismaClientKnownRequestError("Cannot reach database", {
      code: "P1001",
      clientVersion: Prisma.prismaVersion.client
    });
    const create = vi.fn().mockRejectedValue(outage);
    const update = vi.fn();

    await expect(signUpMember(db({ create, update }), AUREA, INPUT, "qr_signup", NOW)).rejects.toBe(
      outage
    );
    expect(update).not.toHaveBeenCalled();
  });
});
