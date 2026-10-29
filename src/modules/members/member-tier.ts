import { normaliseScale } from "../points/tier-engine";
import { tierRewardsSchema } from "../templates/templates.schema";

/** What a member with no stored tier and no usable template scale is called. */
export const NEW_MEMBER_TIER = "Nuevo";

/** The template's lowest tier, or "" when its scale is missing or unusable. */
export const baseTierFromTemplate = (tierRewards: unknown): string => {
  const parsed = tierRewardsSchema.safeParse(tierRewards ?? []);

  if (!parsed.success) return "";

  try {
    return (
      normaliseScale(
        parsed.data.map((tier) => ({
          code: tier.name,
          label: tier.name,
          minLifetimePoints: tier.minLifetimePoints
        }))
      )[0]?.code ?? ""
    );
  } catch {
    return "";
  }
};

/**
 * The tier a screen shows for a member: the one she holds, else the template's lowest, else
 * "Nuevo". The single place that decides, so the members list and detail, the scan/pass
 * lookup and the admin list cannot disagree about a member who has no tier yet.
 */
export const tierLabelFor = (tier: string | null, templateTierRewards: unknown): string =>
  tier || baseTierFromTemplate(templateTierRewards) || NEW_MEMBER_TIER;
