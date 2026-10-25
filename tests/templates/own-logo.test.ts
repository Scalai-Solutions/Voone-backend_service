import { describe, expect, it } from "vitest";

import {
  BORROWED_DEFAULT_IMAGE_URLS,
  hasOwnLogo,
  usesBorrowedImages
} from "../../src/modules/templates/own-logo";

const DEFAULT_LOGO = "https://cdn.voone.example/voone-logo.png";

describe("hasOwnLogo", () => {
  it("is false when there is no logo", () => {
    expect(hasOwnLogo({ logoUrl: null }, DEFAULT_LOGO)).toBe(false);
    expect(hasOwnLogo({ logoUrl: "" })).toBe(false);
    expect(hasOwnLogo({ logoUrl: " \n\t " })).toBe(false);
  });

  it("is false for the configured Voone default, even padded with whitespace", () => {
    expect(hasOwnLogo({ logoUrl: DEFAULT_LOGO }, DEFAULT_LOGO)).toBe(false);
    expect(hasOwnLogo({ logoUrl: ` ${DEFAULT_LOGO} ` }, DEFAULT_LOGO)).toBe(false);
  });

  it("is false for either borrowed image, with or without a configured default", () => {
    for (const url of BORROWED_DEFAULT_IMAGE_URLS) {
      expect(hasOwnLogo({ logoUrl: url })).toBe(false);
      expect(hasOwnLogo({ logoUrl: url }, DEFAULT_LOGO)).toBe(false);
    }
  });

  it("is true for any other URL, including one on the borrowed images' host", () => {
    expect(hasOwnLogo({ logoUrl: "https://clinica.example/logo.png" }, DEFAULT_LOGO)).toBe(true);
    expect(hasOwnLogo({ logoUrl: "https://i.ibb.co/own/logo.png" }, DEFAULT_LOGO)).toBe(true);
    expect(hasOwnLogo({ logoUrl: DEFAULT_LOGO })).toBe(true);
  });
});

describe("usesBorrowedImages", () => {
  const own = {
    logoUrl: "https://clinica.example/logo.png",
    logoOnDarkUrl: "https://clinica.example/logo-dark.png",
    heroImageUrl: "https://clinica.example/hero.png"
  };

  it("is false when every image is the clinic's own or absent", () => {
    expect(usesBorrowedImages(own)).toBe(false);
    expect(usesBorrowedImages({ logoUrl: null, logoOnDarkUrl: null, heroImageUrl: null })).toBe(
      false
    );
  });

  it.each(["logoUrl", "logoOnDarkUrl", "heroImageUrl"] as const)(
    "is true when %s is a borrowed image",
    (field) => {
      for (const url of BORROWED_DEFAULT_IMAGE_URLS) {
        expect(usesBorrowedImages({ ...own, [field]: url })).toBe(true);
      }
    }
  );

  it("compares the exact URL, not the host", () => {
    expect(usesBorrowedImages({ ...own, heroImageUrl: "https://i.ibb.co/own1234/hero.png" })).toBe(
      false
    );
  });
});
