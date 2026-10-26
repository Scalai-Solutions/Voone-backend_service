import { describe, expect, it } from "vitest";

import {
  DEFAULT_WALLET_BENEFITS_TEXT,
  DEFAULT_WALLET_BUTTONS,
  DEFAULT_WALLET_INFO_TEXT,
  DEFAULT_WALLET_POINTS_LABEL,
  DEFAULT_WALLET_TEXT_MODULES,
  DEFAULT_WALLET_TIER_LABEL
} from "../../src/modules/templates/default-voone-template";

describe("default template texts", () => {
  it("speaks of miembros, never socias", () => {
    expect(DEFAULT_WALLET_BENEFITS_TEXT).toBe(
      "Ventajas exclusivas para miembros, prioridad de reserva y recompensas especiales."
    );
    expect(JSON.stringify([DEFAULT_WALLET_BENEFITS_TEXT, DEFAULT_WALLET_INFO_TEXT])).not.toMatch(
      /\bsocias?\b/i
    );
  });

  it("keeps the neutral labels and the info text", () => {
    expect(DEFAULT_WALLET_TIER_LABEL).toBe("Nivel");
    expect(DEFAULT_WALLET_POINTS_LABEL).toBe("Puntos");
    expect(DEFAULT_WALLET_INFO_TEXT).toBe(
      "Presenta tu pase en recepción antes del pago para sumar puntos."
    );
  });

  it("labels the default links and modules in Spanish", () => {
    expect(DEFAULT_WALLET_BUTTONS.map((button) => button.label)).toEqual(["Web", "Reservar cita"]);
    expect(DEFAULT_WALLET_TEXT_MODULES.map((module) => module.label)).toEqual([
      "Beneficios",
      "Información"
    ]);
    expect(DEFAULT_WALLET_TEXT_MODULES[0].value).toBe(DEFAULT_WALLET_BENEFITS_TEXT);
  });
});
