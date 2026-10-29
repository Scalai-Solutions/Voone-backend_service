import { describe, expect, it } from "vitest";

import { NEW_MEMBER_TIER, tierLabelFor } from "../../src/modules/members/member-tier";

/**
 * One answer to "what tier do we show for this member", used by the members list and detail,
 * the scan/pass lookup and the admin list, so the same member never reads "Nuevo" on one screen
 * and "Bronze" on another.
 */
describe("tierLabelFor", () => {
  const scale = [
    { name: "Silver", minLifetimePoints: 1000 },
    { name: "Bronze", minLifetimePoints: 0 }
  ];

  it("shows the tier the member holds", () => {
    expect(tierLabelFor("Oro", scale)).toBe("Oro");
  });

  it("falls back to the template's lowest tier when the member has none", () => {
    expect(tierLabelFor(null, scale)).toBe("Bronze");
  });

  it("falls back to Nuevo when there is no usable template scale", () => {
    expect(tierLabelFor(null, [])).toBe(NEW_MEMBER_TIER);
    expect(tierLabelFor(null, undefined)).toBe(NEW_MEMBER_TIER);
    expect(tierLabelFor(null, "not a scale")).toBe(NEW_MEMBER_TIER);
    expect(NEW_MEMBER_TIER).toBe("Nuevo");
  });

  it("at a programme centre falls back to the programme's first rung, not the template's old scale", () => {
    expect(tierLabelFor(null, scale, true)).toBe("Bronce");
    expect(tierLabelFor(null, [], true)).toBe("Bronce");
    expect(tierLabelFor("Oro", scale, true)).toBe("Oro");
  });

  it("keeps the template fallback at a centre without a programme", () => {
    expect(tierLabelFor(null, scale, false)).toBe("Bronze");
  });
});
