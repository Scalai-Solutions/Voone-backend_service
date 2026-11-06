import { describe, expect, it } from "vitest";

import { paymentReason } from "../../src/modules/onboarding/runtime/visit.service";

describe("paymentReason", () => {
  it("names the treatments picked from the catalogue, once each", () => {
    expect(
      paymentReason([
        { name: "Hydrafacial", amountEuro: 120 },
        { name: "Hydrafacial", amountEuro: 120 },
        { name: "Peeling", amountEuro: 60 },
        { amountEuro: 10 }
      ])
    ).toBe("Visita de pago: Hydrafacial, Peeling");
  });

  it("stays generic when nothing was picked by name", () => {
    expect(paymentReason([{ amountEuro: 65 }])).toBe("Visita de pago");
  });
});
