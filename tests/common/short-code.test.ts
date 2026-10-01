import { describe, expect, it } from "vitest";

import {
  CLINIC_SLUG_ALPHABET,
  generateClinicSlug,
  generateMemberCode,
  generateShortCode,
  MEMBER_CODE_ALPHABET,
  SHORT_CODE_LENGTH
} from "../../src/common/utils/short-code";

/** Both identifiers are read off paper by people, so these assert legibility. */
const AMBIGUOUS = ["i", "l", "o", "0", "1", "I", "L", "O"];

const sample = (make: () => string, times = 400): string[] => Array.from({ length: times }, make);

describe("generateShortCode", () => {
  it("is five characters, because that is what was asked for", () => {
    expect(generateClinicSlug()).toHaveLength(SHORT_CODE_LENGTH);
    expect(generateMemberCode()).toHaveLength(SHORT_CODE_LENGTH);
  });

  it("never emits a character that could be misread", () => {
    // The reason the alphabet is 31 rather than 36. A member reading their code over the
    // phone, or a clinic typing a slug off a poster, must not have to guess between
    // l and 1.
    for (const code of [...sample(generateClinicSlug), ...sample(generateMemberCode)]) {
      for (const character of AMBIGUOUS) {
        expect(code).not.toContain(character);
      }
    }
  });

  it("keeps a clinic slug lowercase, so it reads as part of a URL", () => {
    for (const slug of sample(generateClinicSlug)) {
      expect(slug).toBe(slug.toLowerCase());
      expect([...slug].every((character) => CLINIC_SLUG_ALPHABET.includes(character))).toBe(true);
    }
  });

  it("keeps a member code uppercase, so it reads as a code on a card", () => {
    for (const code of sample(generateMemberCode)) {
      expect(code).toBe(code.toUpperCase());
      expect([...code].every((character) => MEMBER_CODE_ALPHABET.includes(character))).toBe(true);
    }
  });

  it("produces a new slug each time rather than a constant", () => {
    // Guards the shape of the bug where a generator is written once and reused, which
    // would make every clinic after the first fail its unique index.
    expect(new Set(sample(generateClinicSlug)).size).toBeGreaterThan(300);
  });

  it("uses every character of the alphabet, so none is unreachable", () => {
    // An off-by-one in the index would silently drop the last character — and leave a
    // generator that still looks correct in every other assertion here.
    const seen = new Set(sample(() => generateShortCode(CLINIC_SLUG_ALPHABET, 32), 400).join(""));

    expect(seen.size).toBe(CLINIC_SLUG_ALPHABET.length);
  });

  it("honours an explicit length, for a caller that needs a longer code", () => {
    expect(generateShortCode(MEMBER_CODE_ALPHABET, 12)).toHaveLength(12);
  });
});
