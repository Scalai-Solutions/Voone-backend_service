import { describe, expect, it } from "vitest";

import { cardButtonsOf, contactButtonsOf } from "../../src/wallet/engine/program-template";

describe("contact buttons on the card", () => {
  it("turns the centre's phone and email into tel: and mailto: links", () => {
    expect(
      contactButtonsOf({ contactPhone: "+34 910 00-00 00", contactEmail: "hola@clinic.com" })
    ).toEqual([
      { label: "Llamar al centro", url: "tel:+34910000000" },
      { label: "Escribir al centro", url: "mailto:hola@clinic.com" }
    ]);
  });

  it("adds nothing for a centre without contact details", () => {
    expect(contactButtonsOf({ contactPhone: null, contactEmail: null })).toEqual([]);
    expect(contactButtonsOf({ contactPhone: "  ", contactEmail: "" })).toEqual([]);
  });

  it("puts them after the clinic's own buttons", () => {
    expect(
      cardButtonsOf([{ label: "Instagram", url: "https://instagram.com/x" }], {
        contactPhone: "910000000"
      }).map((button) => button.label)
    ).toEqual(["Instagram", "Llamar al centro"]);
  });
});
