import type { Program, TierCode } from "./engine.types";
import { presentProgram, type PresentedTier } from "./presentation";

/**
 * What a client may read about a clinic's programme on its public club page.
 *
 * A projection of `presentProgram` (the centre-safe view the wallet card also reads), so the page
 * and the card cannot disagree and no cost or retail value can reach it: this never asks for the
 * admin projection. Plain data only, safe to serialise to an unauthenticated reader.
 */

export interface ClubBenefit {
  text: string;
  /** Against the tier below: a line it did not have ("new") or the same line made better ("up"). */
  badge?: "new" | "up";
}

export interface ClubTier {
  key: TierCode;
  label: string;
  benefits: ClubBenefit[];
}

export interface ClubStep {
  title: string;
  /** A sentence under the title. Empty for a gift, which is its own title. */
  detail: string;
  /** What kind of step it is, for the ticket stub. */
  label: string;
  /** A short mark beside the label ("×2"), or null. */
  mark: string | null;
}

/** The steps that arrive while a client is in one tier, in order. */
export interface ClubLadderGroup {
  tierKey: TierCode;
  tierLabel: string;
  steps: ClubStep[];
}

export interface PublicClub {
  tiers: ClubTier[];
  ladder: ClubLadderGroup[];
  /** After the last tier: one reward for every `every` euros paid. */
  recurring: { every: number; name: string };
  referrals: Array<{ n: number; name: string }>;
  /** Progress, in euros, a referred client starts with. */
  welcome: number;
}

const PERK_STUBS: Record<string, { label: string; mark: string | null }> = {
  diag: { label: "Valoración", mark: "Gratis" },
  doble: { label: "Próxima visita", mark: "×2" },
  mejora: { label: "Mejora", mark: null },
  sorpresa: { label: "Sorpresa", mark: "?" }
};

const badgeFor = (
  line: PresentedTier["benefitLines"][number],
  below: PresentedTier | undefined
): ClubBenefit["badge"] => {
  // A line the centre wrote has no stable key across tiers, so it never carries a badge.
  if (!below || line.kind !== "generated") return undefined;

  const before = below.benefitLines.find(
    (candidate) => candidate.key === line.key && !candidate.hidden
  );

  if (!before) return "new";

  return before.text !== line.text ? "up" : undefined;
};

export const clubView = (output: Program): PublicClub => {
  const presented = presentProgram(output);

  const tiers = presented.tiers.map((tier, index): ClubTier => {
    const below = presented.tiers[index - 1];

    return {
      key: tier.key,
      label: tier.label,
      benefits: tier.benefitLines
        .filter((line) => !line.hidden)
        .map((line) => {
          const badge = badgeFor(line, below);

          return badge ? { text: line.text, badge } : { text: line.text };
        })
    };
  });

  const ladder: ClubLadderGroup[] = [];

  for (const [index, tier] of presented.tiers.entries()) {
    const steps = presented.ladder
      .filter((milestone) => milestone.band === index + 1)
      .flatMap((milestone): ClubStep[] => {
        if (milestone.type === "premio" && milestone.reward) {
          return [{ title: milestone.reward.name, detail: "", label: "Regalo", mark: null }];
        }

        if (milestone.type === "ventaja" && milestone.perk) {
          const stub = PERK_STUBS[milestone.perk.kind] ?? { label: "Ventaja", mark: null };

          return [
            {
              title: milestone.perk.name,
              detail: milestone.perk.description,
              label: stub.label,
              mark: stub.mark
            }
          ];
        }

        return [];
      });

    if (steps.length > 0) ladder.push({ tierKey: tier.key, tierLabel: tier.label, steps });
  }

  return {
    tiers,
    ladder,
    recurring: { every: presented.recurring.every, name: presented.recurring.name },
    referrals: presented.referrals.map((referral) => ({ n: referral.n, name: referral.name })),
    welcome: presented.welcomeProgress
  };
};
