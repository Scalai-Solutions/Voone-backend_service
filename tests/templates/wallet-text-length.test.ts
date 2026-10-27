import { describe, expect, it } from "vitest";

import { provisionClinicSchema } from "../../src/modules/clinics/clinic-provisioning.schema";
import {
  DEFAULT_WALLET_BENEFITS_TEXT,
  DEFAULT_WALLET_INFO_TEXT
} from "../../src/modules/templates/default-voone-template";
import {
  createTemplateSchema,
  createVooneTemplateSchema,
  updateTemplateSchema,
  updateVooneTemplateSchema
} from "../../src/modules/templates/templates.schema";
import { findOverlongWalletTexts } from "../../src/modules/templates/wallet-text-audit";
import { CARD_TEXT_MAX_LENGTH } from "../../src/wallet/engine/card-text";
import { cardTemplateSchema } from "../../src/wallet/engine/loyalty-card";

const TEMPLATE = {
  presetId: "preset-1",
  programName: "AURÉA Clinic Club",
  hexBackgroundColor: "#ead0bd",
  pointsLabel: "Puntos",
  tierLabel: "Nivel",
  benefitsText: "Acumula puntos en cada visita.",
  infoText: "Presenta tu pase en recepción.",
  treatments: [{ name: "Limpieza facial", pointsAllotted: 50 }]
};

const VOONE = {
  name: "Preset",
  programName: "Club",
  hexBackgroundColor: "#ead0bd",
  pointsLabel: "Puntos",
  tierLabel: "Nivel",
  benefitsText: "Acumula puntos en cada visita.",
  infoText: "Presenta tu pase en recepción.",
  buttons: [],
  textModules: []
};

const PROVISION = {
  name: "Clínica",
  addressLine: "Calle Mayor 1",
  pincode: "28001",
  presetId: "preset-1",
  programName: "Club"
};

const messageOf = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((issue) => issue.message).join("|");

describe("wallet text length on every write path", () => {
  it("the shared limit is the card schema's limit", () => {
    expect(CARD_TEXT_MAX_LENGTH).toBe(500);
  });

  it("the default texts fit the card", () => {
    expect(DEFAULT_WALLET_BENEFITS_TEXT.length).toBeLessThanOrEqual(CARD_TEXT_MAX_LENGTH);
    expect(DEFAULT_WALLET_INFO_TEXT.length).toBeLessThanOrEqual(CARD_TEXT_MAX_LENGTH);
  });

  const writers = {
    createTemplateSchema: (extra: object) =>
      createTemplateSchema.safeParse({ ...TEMPLATE, ...extra }),
    updateTemplateSchema: (extra: object) =>
      updateTemplateSchema.safeParse({ ...TEMPLATE, ...extra }),
    provisionClinicSchema: (extra: object) =>
      provisionClinicSchema.safeParse({ ...PROVISION, ...extra }),
    createVooneTemplateSchema: (extra: object) =>
      createVooneTemplateSchema.safeParse({ ...VOONE, ...extra }),
    updateVooneTemplateSchema: (extra: object) =>
      updateVooneTemplateSchema.safeParse({ ...VOONE, ...extra })
  };

  for (const [name, parse] of Object.entries(writers)) {
    for (const field of ["benefitsText", "infoText"]) {
      it(`${name} rejects 501 characters of ${field} with a Spanish message`, () => {
        const result = parse({ [field]: "a".repeat(501) });

        expect(result.success).toBe(false);
        expect(messageOf(result)).toContain("Máximo 500 caracteres");
      });

      it(`${name} accepts exactly 500 characters of ${field}`, () => {
        expect(parse({ [field]: "a".repeat(500) }).success).toBe(true);
      });

      it(`${name} still falls back to the default for a blank ${field}`, () => {
        const result = parse({ [field]: "   " });

        expect(result.success).toBe(true);
      });
    }
  }

  it("keeps the minimum of 8 on the clinic template", () => {
    expect(createTemplateSchema.safeParse({ ...TEMPLATE, benefitsText: "corto" }).success).toBe(
      false
    );
  });

  it("counts the same unit as the card schema, so nothing passes here and fails there", () => {
    // 250 emoji = 250 code points but 500 UTF-16 units; 251 = 502 units.
    const fits = "😀".repeat(250);
    const tooLong = "😀".repeat(251);

    for (const text of [fits, tooLong]) {
      const accepted = createTemplateSchema.safeParse({
        ...TEMPLATE,
        benefitsText: text,
        infoText: text
      }).success;
      const cardAccepts = cardTemplateSchema.safeParse({
        programName: "Club",
        backgroundColor: "#ead0bd",
        pointsLabel: "Puntos",
        tierLabel: "Nivel",
        benefitsText: text,
        infoText: text
      }).success;

      expect(accepted).toBe(cardAccepts);
    }

    expect(
      createTemplateSchema.safeParse({ ...TEMPLATE, benefitsText: fits, infoText: fits }).success
    ).toBe(true);
    expect(createTemplateSchema.safeParse({ ...TEMPLATE, benefitsText: tooLong }).success).toBe(
      false
    );
  });
});

describe("findOverlongWalletTexts", () => {
  it("reports clinic id and counts, never the text", () => {
    const secret = "texto-secreto-".repeat(60);
    const report = findOverlongWalletTexts([
      { clinicId: "c-ok", benefitsText: "a".repeat(500), infoText: null },
      { clinicId: "c-long", benefitsText: secret, infoText: "b".repeat(501) },
      { clinicId: "c-info", benefitsText: "corto", infoText: "c".repeat(900) }
    ]);

    expect(report).toEqual({
      benefitsOver: 1,
      infoOver: 2,
      clinics: [
        { clinicId: "c-long", benefits: true, info: true },
        { clinicId: "c-info", benefits: false, info: true }
      ]
    });
    expect(JSON.stringify(report)).not.toContain("secreto");
  });
});
