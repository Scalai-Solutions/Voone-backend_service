import { describe, expect, it } from "vitest";

import {
  clinicSlugSchema,
  membershipSignupSchema
} from "../../src/modules/members/membership.schema";

const VALID = {
  name: "Verónica Navarro",
  phone: "612 34 56 78",
  consentMarketing: false
};

/** The repo's error-detail idiom, used by env.ts, the wallet config, and the engine. */
const details = (input: unknown): string => {
  const parsed = membershipSignupSchema.safeParse(input);
  if (parsed.success) throw new Error("expected a validation failure");
  return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
};

describe("membershipSignupSchema", () => {
  it("emits a canonical name and an E.164 phone, so nothing else must remember to", () => {
    const parsed = membershipSignupSchema.parse({
      name: "  Verónica   Navarro ",
      phone: "(+34) 612-34-56-78",
      consentMarketing: true
    });

    expect(parsed).toEqual({
      name: "Verónica Navarro",
      phone: "+34612345678",
      phoneRaw: "(+34) 612-34-56-78",
      phoneRegionAssumed: false,
      consentMarketing: true
    });
  });

  it("keeps the raw phone, so a future re-normalization is a backfill not data loss", () => {
    const parsed = membershipSignupSchema.parse(VALID);

    expect(parsed.phone).toBe("+34612345678");
    expect(parsed.phoneRaw).toBe("612 34 56 78");
  });

  it("records that Spain was assumed, since a bare number states no country", () => {
    expect(membershipSignupSchema.parse(VALID).phoneRegionAssumed).toBe(true);
    expect(
      membershipSignupSchema.parse({ ...VALID, phone: "+34612345678" }).phoneRegionAssumed
    ).toBe(false);
  });

  it("strips unknown keys rather than trusting the client's shape", () => {
    const parsed = membershipSignupSchema.parse({ ...VALID, tier: "DIAMOND", id: "hax" });

    expect(parsed).not.toHaveProperty("tier");
    expect(parsed).not.toHaveProperty("id");
  });

  describe("consent", () => {
    // Membership rests on contract, not consent. Marketing consent is a mandatory FIELD
    // whose VALUE may be false — requiring true would condition sign-up on consent.
    it("creates a member when marketing consent is declined", () => {
      expect(membershipSignupSchema.parse({ ...VALID, consentMarketing: false })).toMatchObject({
        consentMarketing: false
      });
    });

    it("rejects a missing consent field, so an absent choice is never read as a choice", () => {
      const withoutConsent = { name: VALID.name, phone: VALID.phone };

      expect(details(withoutConsent)).toContain("consentMarketing");
    });

    it('rejects the STRING "false", which coercion would silently turn into consent', () => {
      expect(details({ ...VALID, consentMarketing: "false" })).toContain("consentMarketing");
      expect(details({ ...VALID, consentMarketing: "true" })).toContain("consentMarketing");
      expect(details({ ...VALID, consentMarketing: 1 })).toContain("consentMarketing");
    });
  });

  describe("name", () => {
    it("rejects a name that is empty once cleaned", () => {
      expect(details({ ...VALID, name: "   " })).toMatch(/name/);
    });

    it("rejects a single character", () => {
      expect(details({ ...VALID, name: "V" })).toMatch(/name/);
    });

    it("rejects a name longer than the pass field can carry", () => {
      expect(details({ ...VALID, name: "á".repeat(65) })).toMatch(/name/);
      expect(membershipSignupSchema.parse({ ...VALID, name: "á".repeat(64) }).name).toHaveLength(
        64
      );
    });

    it("rejects digits and injection payloads", () => {
      expect(details({ ...VALID, name: "12345" })).toMatch(/name/);
      expect(details({ ...VALID, name: "Ana <script>" })).toMatch(/name/);
    });
  });

  describe("email", () => {
    it("is optional, because the phone is the identity", () => {
      expect(membershipSignupSchema.parse(VALID).email).toBeUndefined();
    });

    it("lowercases, so one address cannot be stored two ways", () => {
      expect(membershipSignupSchema.parse({ ...VALID, email: "  Ana@Example.COM " }).email).toBe(
        "ana@example.com"
      );
    });

    it("rejects something that is not an address", () => {
      expect(details({ ...VALID, email: "ana@" })).toContain("email");
      expect(details({ ...VALID, email: "nope" })).toContain("email");
    });
  });

  describe("consentSource", () => {
    it("is omitted by the public form, which the route reads as a QR sign-up", () => {
      expect(membershipSignupSchema.parse(VALID).consentSource).toBeUndefined();
    });

    it("accepts a staff entry, so provenance is not attributed to the public form", () => {
      expect(
        membershipSignupSchema.parse({ ...VALID, consentSource: "staff_entry" }).consentSource
      ).toBe("staff_entry");
    });

    it("rejects a provenance it does not know, in Spanish like every other message", () => {
      expect(details({ ...VALID, consentSource: "imported" })).toBe(
        "consentSource: Origen de alta no válido"
      );
      expect(details({ ...VALID, consentSource: "" })).toContain("consentSource");
    });

    it("does not list the accepted values, which are an internal shape", () => {
      expect(details({ ...VALID, consentSource: "imported" })).not.toContain("qr_signup");
    });
  });

  describe("phone", () => {
    it("reports an invalid number in Spanish, since the form renders the message", () => {
      expect(details({ ...VALID, phone: "912345678" })).toBe(
        "phone: Introduce un móvil español válido"
      );
    });

    it("rejects a foreign number rather than reinterpreting it as Spanish", () => {
      expect(details({ ...VALID, phone: "+33612345678" })).toMatch(/phone/);
    });
  });

  it("reports every failing field at once, so the form can show them together", () => {
    const message = details({ name: "1", phone: "nope", consentMarketing: "yes" });

    expect(message).toContain("name");
    expect(message).toContain("phone");
    expect(message).toContain("consentMarketing");
  });
});

describe("clinicSlugSchema", () => {
  it("accepts the slugs a QR poster can carry", () => {
    for (const slug of ["aurea", "lumiere", "clinica-aurea", "med-skin-2"]) {
      expect(clinicSlugSchema.safeParse(slug).success, slug).toBe(true);
    }
  });

  it("rejects anything that could not be a seeded slug", () => {
    for (const slug of [
      "AUREA",
      "aurea/",
      "../../etc/passwd",
      "aurea ",
      "-aurea",
      "aurea-",
      "aurea--clinic",
      "аurea",
      "",
      "a".repeat(65)
    ]) {
      expect(clinicSlugSchema.safeParse(slug).success, JSON.stringify(slug)).toBe(false);
    }
  });
});

describe("clinicSlugSchema messages", () => {
  it("explains the rule instead of printing the pattern", () => {
    // An operator reads this in the provisioning form, so a regex dump is not an answer.
    const parsed = clinicSlugSchema.safeParse("Clinica Nova");

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe(
        "Usa minúsculas, números y guiones (por ejemplo: clinica-nova)"
      );
      expect(parsed.error.issues[0].message).not.toContain("pattern");
    }
  });
});
