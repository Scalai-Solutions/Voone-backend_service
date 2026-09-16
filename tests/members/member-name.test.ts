import { describe, expect, it } from "vitest";

import { cleanMemberName, isPlausibleName } from "../../src/modules/members/member-name";

// Invisible characters are written as escapes: a literal one degrades silently when a
// file is re-saved, turning the vector into a duplicate of an ordinary one.
const COMBINING_ACUTE = "́";
const RLO = "‮"; // right-to-left override
const ZWSP = "​";
const NBSP = " ";

describe("cleanMemberName", () => {
  it("normalizes to NFC so one person yields one spelling", () => {
    // "José" with a combining acute is a different string from the precomposed spelling.
    // Without NFC the same member can hold both, and renders two different passes.
    const combining = `Jos${"e" + COMBINING_ACUTE}`;
    const precomposed = "José";

    expect(combining).not.toBe(precomposed);
    expect(cleanMemberName(combining)).toBe(precomposed);
    expect(cleanMemberName(precomposed)).toBe(precomposed);
  });

  it("strips bidi overrides, which can make a pass render a deceptive name", () => {
    expect(cleanMemberName(`${RLO}Verónica`)).toBe("Verónica");
  });

  it("strips zero-width characters rather than treating them as separators", () => {
    expect(cleanMemberName(`Ana${ZWSP}Ruiz`)).toBe("AnaRuiz");
  });

  it("collapses every kind of whitespace run to a single space", () => {
    expect(cleanMemberName("Verónica   Navarro")).toBe("Verónica Navarro");
    expect(cleanMemberName(`Ana${NBSP}Ruiz`)).toBe("Ana Ruiz");
    expect(cleanMemberName("Ana\tRuiz\nSoler")).toBe("Ana Ruiz Soler");
  });

  it("trims", () => {
    expect(cleanMemberName("  Ana Ruiz  ")).toBe("Ana Ruiz");
  });

  it("leaves an already clean name untouched", () => {
    expect(cleanMemberName("Verónica Navarro")).toBe("Verónica Navarro");
  });

  it("is idempotent", () => {
    const once = cleanMemberName(`  ${RLO}José   Nuñez  `);

    expect(cleanMemberName(once)).toBe(once);
  });
});

describe("isPlausibleName", () => {
  it("accepts Spanish, Catalan, and Basque names", () => {
    for (const name of [
      "Verónica Navarro",
      "José Ñúñez",
      "María del Carmen García-López",
      "Paul O'Donnell",
      "Núria Plaça",
      "Marcel·lí Riera",
      "J. Alberto Ruiz"
    ]) {
      expect(isPlausibleName(name), name).toBe(true);
    }
  });

  it("rejects input carrying no letter at all", () => {
    for (const name of ["12345", "---", ".", "42 42", ""]) {
      expect(isPlausibleName(name), name).toBe(false);
    }
  });

  it("rejects digits and symbols mixed into a name, which is bot noise", () => {
    for (const name of ["Ana Ruiz 2", "Ana <script>", "ana@example.com", "Ana_Ruiz"]) {
      expect(isPlausibleName(name), name).toBe(false);
    }
  });
});
