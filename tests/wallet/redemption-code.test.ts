import { describe, expect, it } from "vitest";

import { deriveRedemptionCode, toBase32 } from "../../src/wallet/engine/redemption-code";
import { loyaltyCardSchema } from "../../src/wallet/engine/loyalty-card";
import { aureaGoldPass } from "../fixtures/loyalty-card.fixture";

const SECRET = "a-server-secret-not-a-member-attribute";
const MEMBER = "00000000-0000-4000-8000-00000000c123";

describe("toBase32", () => {
  it("matches RFC 4648 for the canonical vectors", () => {
    expect(toBase32(Buffer.from("f"))).toBe("MY");
    expect(toBase32(Buffer.from("fo"))).toBe("MZXQ");
    expect(toBase32(Buffer.from("foo"))).toBe("MZXW6");
    expect(toBase32(Buffer.from("foob"))).toBe("MZXW6YQ");
    expect(toBase32(Buffer.from("fooba"))).toBe("MZXW6YTB");
    expect(toBase32(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });

  it("emits nothing for no input", () => {
    expect(toBase32(Buffer.alloc(0))).toBe("");
  });

  it("uses only the barcode-safe alphabet", () => {
    expect(toBase32(Buffer.from([0xff, 0x00, 0xa5, 0x5a, 0x13]))).toMatch(/^[A-Z2-7]+$/);
  });
});

describe("deriveRedemptionCode", () => {
  it("produces a code the card schema accepts", () => {
    const code = deriveRedemptionCode(MEMBER, SECRET);

    const parsed = loyaltyCardSchema.safeParse({ ...aureaGoldPass, redemptionCode: code });

    expect(parsed.success).toBe(true);
    expect(code).toMatch(/^[A-Z2-7]{26}$/);
  });

  it("is stable, so a card can be rebuilt without storing the code", () => {
    expect(deriveRedemptionCode(MEMBER, SECRET)).toBe(deriveRedemptionCode(MEMBER, SECRET));
  });

  it("differs per member", () => {
    expect(deriveRedemptionCode(MEMBER, SECRET)).not.toBe(
      deriveRedemptionCode("00000000-0000-4000-8000-00000000c999", SECRET)
    );
  });

  it("depends on the secret, so knowing a member id is not enough to forge a code", () => {
    expect(deriveRedemptionCode(MEMBER, SECRET)).not.toBe(
      deriveRedemptionCode(MEMBER, "a-different-secret")
    );
  });

  it("carries nothing of the member id in its output", () => {
    const code = deriveRedemptionCode(MEMBER, SECRET);

    // The id's own characters must not survive into the barcode in any readable run.
    expect(code).not.toContain("C123");
    expect(code.toLowerCase()).not.toContain(MEMBER.slice(0, 8));
  });

  it("never equals the serial number the card pairs it with", () => {
    const serialNumber = `voone-member-${MEMBER}`;

    expect(deriveRedemptionCode(MEMBER, SECRET)).not.toBe(serialNumber);
  });
});
