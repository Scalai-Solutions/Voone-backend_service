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

/**
 * A tier, as the clinic authors it during onboarding.
 *
 * `minLifetimePoints` is what makes a tier a tier rather than a label: without it
 * nothing can decide which one a member is in, which is why every card showed no tier
 * until now even though the wizard collected five of them.
 *
 * Milestones are per tier, not per clinic. Bronze can be five steps of 500 while
 * Diamond is ten of 5000 — a single clinic-wide ladder cannot express that.
 */
export const tierRewardInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  rewardText: z.string().trim().max(500).optional().or(z.literal("")),

  /** Inclusive floor, in LIFETIME points earned. The lowest tier is normally 0. */
  minLifetimePoints: z.coerce.number().int().min(0).max(10_000_000).default(0),

  /** How many reward steps sit inside this tier. */
  milestoneCount: z.coerce.number().int().min(1).max(100).default(10),

  /** Points between those steps, within this tier. */
  pointsToNextMilestone: z.coerce.number().int().min(1).max(10_000_000).default(2000)
});

/**
 * The authored list, ordered and checked.
 *
 * Two scales are unusable rather than merely odd, and both are far cheaper to reject
 * here than to discover from a member holding the wrong tier: two tiers sharing a floor
 * (which one a member holds would depend on array order) and two sharing a name (the
 * pass would show whichever was found first).
 */
export const tierRewardsSchema = z
  .array(tierRewardInputSchema)
  .max(20)
  .superRefine((tiers, ctx) => {
    const floors = new Set<number>();
    const names = new Set<string>();

    for (const tier of tiers) {
      const name = tier.name.toLocaleLowerCase();

      if (floors.has(tier.minLifetimePoints)) {
        ctx.addIssue({
          code: "custom",
          message: `Dos niveles empiezan en ${tier.minLifetimePoints} puntos`
        });
      }

      if (names.has(name)) {
        ctx.addIssue({ code: "custom", message: `El nivel "${tier.name}" está repetido` });
      }

      floors.add(tier.minLifetimePoints);
      names.add(name);
    }
  });

/**
 * Clinic-wide reward settings.
 *
 * `milestoneCount` and `pointsToNextMilestone` are DEPRECATED here: they moved onto each
 * tier, because a clinic-wide ladder cannot give Bronze and Diamond different rhythms.
 * They are still accepted so existing templates keep validating, and are no longer read
 * by anything. Remove them once the onboarding form stops sending them.
 *
 * `priceAmount` and `pointsAwarded` are left exactly as they were. They look like an
 * earning rate rather than a milestone property, but that is an inference and not mine
 * to act on — see the note on VOO-124.
 */
export const milestoneRewardsSchema = z.object({
  milestoneCount: z.coerce.number().int().min(1).max(100).default(10),
  pointsToNextMilestone: z.coerce.number().int().min(1).max(10_000_000).default(2000),
  priceAmount: z.coerce.number().int().min(1).max(1_000_000).default(10),
  pointsAwarded: z.coerce.number().int().min(1).max(10_000_000).default(100)
});

/**
 * A working default, not a placeholder: a clinic that changes nothing still gets a scale
 * that ranks members, rather than five names that rank nobody.
 *
 * The spacing widens as the tiers climb, which is the shape loyalty programmes usually
 * take — reaching Silver should feel attainable and Diamond should not.
 */
const defaultTierRewards = [
  { name: "Bronze", minLifetimePoints: 0, milestoneCount: 5, pointsToNextMilestone: 200 },
  { name: "Silver", minLifetimePoints: 1_000, milestoneCount: 5, pointsToNextMilestone: 400 },
  { name: "Gold", minLifetimePoints: 3_000, milestoneCount: 5, pointsToNextMilestone: 800 },
  { name: "Platinum", minLifetimePoints: 7_000, milestoneCount: 5, pointsToNextMilestone: 1_600 },
  { name: "Diamond", minLifetimePoints: 15_000, milestoneCount: 5, pointsToNextMilestone: 3_000 }
].map((tier) => ({ ...tier, rewardText: "" }));

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
  tierRewards: tierRewardsSchema.default(defaultTierRewards),
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
