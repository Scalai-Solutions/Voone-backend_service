import { describe, expect, it } from "vitest";

import type { NormalizedPhone } from "../../src/modules/members/phone-es";
import { NORMALIZER_VERSION, normalizeSpanishMobile } from "../../src/modules/members/phone-es";

/**
 * The @@unique([clinicId, phone]) constraint is only a duplicate check if this function is
 * deterministic: every way one person can type their number must collapse to one string.
 * Each accepted vector below is a way a real submission arrives.
 */
const ACCEPTED: ReadonlyArray<[string, string]> = [
  ["612345678", "+34612345678"],
  ["612 34 56 78", "+34612345678"],
  ["612-34-56-78", "+34612345678"],
  ["612.34.56.78", "+34612345678"],
  ["  612345678  ", "+34612345678"],
  ["+34612345678", "+34612345678"],
  ["+34 612 34 56 78", "+34612345678"],
  ["(+34) 612-34-56-78", "+34612345678"],
  ["0034612345678", "+34612345678"],
  ["00 34 612 34 56 78", "+34612345678"],
  ["34612345678", "+34612345678"],
  // Pasted from iOS Contacts: a non-breaking space rather than U+0020.
  ["612\u00A034\u00A056\u00A078", "+34612345678"],
  // Pasted from WhatsApp: wrapped in bidi embedding marks.
  ["\u202A+34612345678\u202C", "+34612345678"],
  // Typed on a fullwidth IME keyboard. NFKC is what rescues this.
  ["＋３４６１２３４５６７８", "+34612345678"],
  // 7xx is a valid Spanish mobile range.
  ["712345678", "+34712345678"]
];

const REJECTED: ReadonlyArray<[string, string]> = [
  ["+33612345678", "explicit French country code"],
  ["0033612345678", "French number via the 00 exit code"],
  ["+1 415 555 0123", "US number"],
  ["912345678", "Madrid landline — cannot receive the SMS this exists for"],
  ["812345678", "8xx landline"],
  ["512345678", "5xx is not an assigned mobile range"],
  ["61234567", "eight digits"],
  ["6123456789", "ten digits"],
  ["+34 6123456789", "country code plus ten digits"],
  ["00612345678", "00 exit code with no country code"],
  ["+340612345678", "country code followed by a leading zero"],
  ["+34", "country code only"],
  ["0034", "exit code and country code only"],
  ["", "empty"],
  ["   ", "whitespace only"],
  ["abc", "letters"],
  ["٦١٢٣٤٥٦٧٨", "Arabic-Indic digits are not ASCII"],
  ["612345678 o 698765432", "two numbers in one field"]
];

describe("normalizeSpanishMobile", () => {
  it.each(ACCEPTED)("normalizes %j to %s", (input, expected) => {
    expect(normalizeSpanishMobile(input)?.e164).toBe(expected);
  });

  it.each(REJECTED)("rejects %j (%s)", (input) => {
    expect(normalizeSpanishMobile(input)).toBeNull();
  });

  // The property that actually protects the unique index: re-normalizing a stored value
  // must be a no-op, or a second submission of the same number would create a second row.
  it.each(ACCEPTED)("is idempotent for %j", (input) => {
    const once = normalizeSpanishMobile(input);
    expect(once).not.toBeNull();
    expect(normalizeSpanishMobile((once as NormalizedPhone).e164)?.e164).toBe(once?.e164);
  });

  it("only ever emits the canonical +34 + nine digits form", () => {
    for (const [input] of ACCEPTED) {
      expect(normalizeSpanishMobile(input)?.e164).toMatch(/^\+34[67][0-9]{8}$/);
    }
  });
});

describe("NORMALIZER_VERSION", () => {
  // Stored on every Member so a future rule change can find the rows it must backfill.
  it("is the version stamped onto stored numbers", () => {
    expect(NORMALIZER_VERSION).toBe(1);
  });
});

describe("regionAssumed", () => {
  // True whenever Spain was inferred rather than stated. This is the majority of real
  // submissions, so it is a filter for a later audit, not an alarm on its own: a French
  // visitor typing a bare national mobile lands on a Spanish number nobody flagged.
  it("is false when the submission states its country code", () => {
    for (const input of ["+34612345678", "0034612345678", "34612345678", "(+34) 612 345 678"]) {
      expect(normalizeSpanishMobile(input)?.regionAssumed, input).toBe(false);
    }
  });

  it("is true when a bare national number forced us to assume Spain", () => {
    for (const input of ["612345678", "612 34 56 78", "712345678"]) {
      expect(normalizeSpanishMobile(input)?.regionAssumed, input).toBe(true);
    }
  });
});

describe("raw", () => {
  it("preserves the submission verbatim, so a re-normalization can be a backfill", () => {
    expect(normalizeSpanishMobile("  (+34) 612-34-56-78 ")?.raw).toBe("  (+34) 612-34-56-78 ");
  });
});
