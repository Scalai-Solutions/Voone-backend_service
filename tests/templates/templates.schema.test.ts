import { describe, expect, it } from "vitest";

import {
  clinicContextSchema,
  createTemplateSchema,
  treatmentInputSchema
} from "../../src/modules/templates/templates.schema";

const VALID = {
  presetId: "preset-1",
  programName: "AURÉA Clinic Club",
  hexBackgroundColor: "#ead0bd",
  pointsLabel: "Puntos",
  tierLabel: "Nivel",
  benefitsText: "Acumula puntos en cada visita.",
  infoText: "Presenta tu pase en recepción.",
  treatments: [{ name: "Limpieza facial", pointsAllotted: 50 }]
};

describe("createTemplateSchema", () => {
  it("accepts a complete template", () => {
    expect(createTemplateSchema.parse(VALID).programName).toBe("AURÉA Clinic Club");
  });

  it("requires a six-digit hex colour, because the pass and page render it directly", () => {
    for (const colour of ["#eab", "ead0bd", "#gggggg", "red", ""]) {
      expect(
        createTemplateSchema.safeParse({ ...VALID, hexBackgroundColor: colour }).success,
        colour
      ).toBe(false);
    }
  });

  it("requires at least one treatment, since points cannot be awarded without one", () => {
    expect(createTemplateSchema.safeParse({ ...VALID, treatments: [] }).success).toBe(false);
  });

  it("caps the treatment list rather than accepting an unbounded write", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ name: `T${i}`, pointsAllotted: 1 }));

    expect(createTemplateSchema.safeParse({ ...VALID, treatments: many }).success).toBe(false);
  });

  it("rejects copy that is too short to be useful on a pass", () => {
    expect(createTemplateSchema.safeParse({ ...VALID, benefitsText: "corto" }).success).toBe(false);
    expect(createTemplateSchema.safeParse({ ...VALID, infoText: "corto" }).success).toBe(false);
  });

  it("treats an empty optional URL as absent rather than invalid", () => {
    expect(createTemplateSchema.parse({ ...VALID, logoUrl: "" }).logoUrl).toBe("");
    expect(createTemplateSchema.safeParse({ ...VALID, logoUrl: "not-a-url" }).success).toBe(false);
  });
});

describe("treatmentInputSchema", () => {
  it("coerces the points a form submits as a string", () => {
    expect(
      treatmentInputSchema.parse({ name: "Facial", pointsAllotted: "50" }).pointsAllotted
    ).toBe(50);
  });

  it("rejects negative and fractional points", () => {
    expect(treatmentInputSchema.safeParse({ name: "Facial", pointsAllotted: -1 }).success).toBe(
      false
    );
    expect(treatmentInputSchema.safeParse({ name: "Facial", pointsAllotted: 1.5 }).success).toBe(
      false
    );
  });
});

describe("clinicContextSchema", () => {
  it("rejects an absent clinic, so a write cannot land unscoped", () => {
    expect(clinicContextSchema.safeParse({ clinicId: undefined }).success).toBe(false);
    expect(clinicContextSchema.safeParse({ clinicId: "   " }).success).toBe(false);
  });
});
