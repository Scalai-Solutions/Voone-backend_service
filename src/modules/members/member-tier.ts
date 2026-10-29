import { TIERS, TIER_NAMES } from "../onboarding/engine.config";
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

/** The lowest rung of every programme ladder (Bronce), which does not depend on the centre. */
const PROGRAMME_FIRST_TIER = TIER_NAMES[TIERS[0]];

/**
 * The tier a staff surface shows for a member (members list and detail, scan/pass lookup, admin
 * list). The single place that decides, so they cannot disagree about a member with no tier.
 *
 * FINAL RULE: the tier she holds; if none, at a centre with a live programme the programme's
 * FIRST rung ("Bronce"), at any other centre the template's lowest tier; if there is no usable
 * scale, "Nuevo". The wallet card is separate on purpose: it shows no tier for a tierless member.
 */
export const tierLabelFor = (
  tier: string | null,
  templateTierRewards: unknown,
  programmeCentre = false
): string =>
  tier ||
  (programmeCentre ? PROGRAMME_FIRST_TIER : baseTierFromTemplate(templateTierRewards)) ||
  NEW_MEMBER_TIER;
