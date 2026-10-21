import { describe, expect, it } from "vitest";

import { newPasswordSchema } from "../src/routes/v1/admin-clinics.route";

/** Founders' E2E item 33: the rules shown on the password pages are the ones enforced here. */
describe("new password rules", () => {
  it("accepts 8+ characters with an uppercase letter and a number", () => {
    expect(newPasswordSchema.safeParse("Voone2026").success).toBe(true);
  });

  it.each([
    ["Short1A", "al menos 8"],
    ["voone2026", "mayúscula"],
    ["VooneVoone", "número"]
  ])("refuses %s", (value, fragment) => {
    const result = newPasswordSchema.safeParse(value);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(fragment);
  });
});
