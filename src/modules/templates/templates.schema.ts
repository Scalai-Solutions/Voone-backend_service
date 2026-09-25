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
  priceEuro: z.coerce.number().int().min(0).max(1_000_000).optional(),
  pointsAllotted: z.coerce.number().int().min(0).max(1_000_000)
});

export const tierRewardInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  rewardText: z.string().trim().max(500).optional().or(z.literal(""))
});

export const milestoneRewardsSchema = z.object({
  milestoneCount: z.coerce.number().int().min(1).max(100).default(10),
  pointsToNextMilestone: z.coerce.number().int().min(1).max(10_000_000).default(2000),
  priceAmount: z.coerce.number().int().min(1).max(1_000_000).default(10),
  pointsAwarded: z.coerce.number().int().min(1).max(10_000_000).default(100)
});

const defaultTierRewards = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"].map(
  (name) => ({ name, rewardText: "" })
);

export const createTemplateSchema = z.object({
  presetId: idSchema,
  programName: z.string().trim().min(2).max(120),
  hexBackgroundColor: hexColorSchema,
  logoUrl: optionalUrlSchema,
  heroImageUrl: optionalUrlSchema,
  websiteUrl: optionalUrlSchema,
  appointmentUrl: optionalUrlSchema,
  appLinkText: z.string().trim().min(1).max(30).optional().or(z.literal("")),
  appLinkDescription: z.string().trim().min(1).max(120).optional().or(z.literal("")),
  pointsLabel: z.string().trim().min(2).max(80),
  tierLabel: z.string().trim().min(2).max(80),
  benefitsText: z.string().trim().min(8).max(1200),
  infoText: z.string().trim().min(8).max(1200),
  tierRewards: z.array(tierRewardInputSchema).max(20).default(defaultTierRewards),
  milestoneRewards: milestoneRewardsSchema.default({
    milestoneCount: 10,
    pointsToNextMilestone: 2000,
    priceAmount: 10,
    pointsAwarded: 100
  }),
  treatments: z.array(treatmentInputSchema).min(1).max(50)
});

export const updateTemplateSchema = createTemplateSchema;

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const vooneTemplateButtonSchema = z.object({
  label: z.string().trim().min(1).max(30),
  url: z.string().url().max(2048),
  description: z.string().trim().min(1).max(120).optional().or(z.literal("")),
  primary: z.boolean().default(false)
});

export const vooneTemplateTextModuleSchema = z.object({
  label: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(1200)
});

export const createVooneTemplateSchema = z.object({
  presetId: idSchema.optional().or(z.literal("")),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  programName: z.string().trim().min(2).max(120),
  hexBackgroundColor: hexColorSchema,
  logoUrl: optionalUrlSchema,
  heroImageUrl: optionalUrlSchema,
  pointsLabel: z.string().trim().min(2).max(80),
  tierLabel: z.string().trim().min(2).max(80),
  benefitsText: z.string().trim().max(1200).optional().or(z.literal("")),
  infoText: z.string().trim().max(1200).optional().or(z.literal("")),
  buttons: z.array(vooneTemplateButtonSchema).max(10),
  textModules: z.array(vooneTemplateTextModuleSchema).max(20)
});

export const updateVooneTemplateSchema = createVooneTemplateSchema;

export type CreateVooneTemplateInput = z.infer<typeof createVooneTemplateSchema>;
