import { describe, expect, it } from "vitest";

import { chooseLogoUrl } from "../../src/wallet/engine/logo-choice";

const both = { logoUrl: "https://cdn/plain.png", logoOnDarkUrl: "https://cdn/on-dark.png" };

describe("chooseLogoUrl", () => {
  it("shows the dark-background logo on a dark card", () => {
    expect(chooseLogoUrl({ ...both, backgroundColor: "#1f2a44" })).toBe(both.logoOnDarkUrl);
  });

  it("shows the ordinary logo on a light card", () => {
    expect(chooseLogoUrl({ ...both, backgroundColor: "#f1dccd" })).toBe(both.logoUrl);
  });

  it("uses whichever logo exists when the clinic uploaded only one", () => {
    expect(chooseLogoUrl({ logoUrl: both.logoUrl, backgroundColor: "#101010" })).toBe(both.logoUrl);
    expect(chooseLogoUrl({ logoOnDarkUrl: both.logoOnDarkUrl, backgroundColor: "#fafafa" })).toBe(
      both.logoOnDarkUrl
    );
  });

  it("is undefined when there is no logo at all", () => {
    expect(chooseLogoUrl({ backgroundColor: "#ffffff" })).toBeUndefined();
  });
});
