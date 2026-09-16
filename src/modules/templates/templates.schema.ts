import { z } from "zod";

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Expected a 6-digit hex color");
const optionalUrlSchema = z.string().url().max(2048).optional().or(z.literal(""));
const idSchema = z.string().trim().min(1).max(120);

export const clinicContextSchema = z.object({
  clinicId: idSchema
});

export const templateParamsSchema = z.object({
  templateId: idSchema
});

export const treatmentInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  pointsAllotted: z.coerce.number().int().min(0).max(1_000_000)
});

export const createTemplateSchema = z.object({
  presetId: idSchema,
  programName: z.string().trim().min(2).max(120),
  hexBackgroundColor: hexColorSchema,
  logoUrl: optionalUrlSchema,
  heroImageUrl: optionalUrlSchema,
  pointsLabel: z.string().trim().min(2).max(80),
  tierLabel: z.string().trim().min(2).max(80),
  benefitsText: z.string().trim().min(8).max(1200),
  infoText: z.string().trim().min(8).max(1200),
  treatments: z.array(treatmentInputSchema).min(1).max(50)
});

export const updateTemplateSchema = createTemplateSchema;

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;