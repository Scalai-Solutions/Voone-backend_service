import { describe, expect, it } from "vitest";

import { CARD_TEXT_MAX_LENGTH, clipCardText } from "../../src/wallet/engine/card-text";

describe("clipCardText", () => {
  it("returns short and exactly-max text untouched", () => {
    expect(clipCardText("hola")).toBe("hola");
    expect(clipCardText("a".repeat(CARD_TEXT_MAX_LENGTH))).toBe("a".repeat(CARD_TEXT_MAX_LENGTH));
  });

  it("clips to the max with an ellipsis", () => {
    const clipped = clipCardText("a".repeat(501));

    expect(clipped).toBe(`${"a".repeat(499)}…`);
    expect(clipped.length).toBe(CARD_TEXT_MAX_LENGTH);
  });

  it("drops a whole emoji rather than keeping half of it", () => {
    const clipped = clipCardText(`${"a".repeat(498)}😀😀`);

    expect(clipped).toBe(`${"a".repeat(498)}…`);
  });
});
