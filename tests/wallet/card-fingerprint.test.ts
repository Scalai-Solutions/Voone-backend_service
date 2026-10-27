import { describe, expect, it } from "vitest";

import { cardFingerprint } from "../../src/wallet/engine/card-fingerprint";
import { aureaGoldPass } from "../fixtures/loyalty-card.fixture";

describe("cardFingerprint", () => {
  it("is equal for the same card whatever order its keys were built in", () => {
    const reversed = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reversed);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, inner]) => [key, reversed(inner)])
        );
      }
      return value;
    };

    expect(cardFingerprint(reversed(aureaGoldPass) as typeof aureaGoldPass)).toBe(
      cardFingerprint(aureaGoldPass)
    );
    expect(JSON.stringify(reversed(aureaGoldPass))).not.toBe(JSON.stringify(aureaGoldPass));
  });

  it("is equal for a deep copy, and treats an undefined field as absent, as the wire does", () => {
    const copy = structuredClone(aureaGoldPass);
    const withUndefined = { ...aureaGoldPass, message: undefined };

    expect(cardFingerprint(copy)).toBe(cardFingerprint(aureaGoldPass));
    expect(cardFingerprint(withUndefined)).toBe(cardFingerprint(aureaGoldPass));
  });

  it("differs when any value differs, in a nested field too", () => {
    const base = cardFingerprint(aureaGoldPass);

    expect(cardFingerprint({ ...aureaGoldPass, points: aureaGoldPass.points + 1 })).not.toBe(base);
    expect(
      cardFingerprint({
        ...aureaGoldPass,
        template: { ...aureaGoldPass.template, pointsLabel: "Otro" }
      })
    ).not.toBe(base);
    expect(cardFingerprint({ ...aureaGoldPass, message: { text: "Hola" } })).not.toBe(base);
  });
});
