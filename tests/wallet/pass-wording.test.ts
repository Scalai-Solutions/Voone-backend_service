import { describe, expect, it } from "vitest";

import {
  PASS_LABELS,
  PASS_TRANSLATIONS
} from "../../src/wallet/providers/apple/apple-pass.strings";

/**
 * The words a member reads on the pass. Spanish and neutral: "miembro", never the feminine
 * "socia", because members are not all women.
 */
describe("Apple pass wording", () => {
  it("calls a member MIEMBRO and a member number N.º DE MIEMBRO", () => {
    expect(PASS_LABELS.member).toBe("MIEMBRO");
    expect(PASS_LABELS.memberNo).toBe("N.º DE MIEMBRO");
    expect(PASS_LABELS.memberCode).toBe("NÚMERO DE MIEMBRO");
    expect(PASS_LABELS.memberSince).toBe("MIEMBRO DESDE");
  });

  it("never uses the feminine word on a label or in a translation", () => {
    const everything = JSON.stringify([PASS_LABELS, PASS_TRANSLATIONS]);

    expect(everything).not.toMatch(/\bsocias?\b/i);
  });

  it("translates every Spanish label, keyed by the label itself", () => {
    const english = PASS_TRANSLATIONS.en;

    for (const label of Object.values(PASS_LABELS)) {
      expect(english, `no English translation for "${label}"`).toHaveProperty([label]);
    }
    expect(english.MIEMBRO).toBe("MEMBER");
    expect(english["N.º DE MIEMBRO"]).toBe("MEMBER NO.");
    expect(english["NÚMERO DE MIEMBRO"]).toBe("MEMBER NUMBER");
    expect(english["MIEMBRO DESDE"]).toBe("MEMBER SINCE");
  });
});
