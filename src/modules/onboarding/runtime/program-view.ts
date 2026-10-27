import { MIN_TENURE, TIERS, TIER_BENEFITS, TIER_NAMES } from "../engine.config";
import type { PerkKind, Program, TierCode } from "../engine.types";
import { rewardTitle } from "../reward-title";

/**
 * A published programme, as the runtime reads it.
 *
 * The engine's output is shaped for generating and reviewing a ladder; the runtime asks
 * different questions — which tier holds at this progress, which milestones did this visit
 * cross, what is issued for them. This is the thin projection between the two, so nothing
 * downstream depends on the engine's internal field names and a change to the output shape
 * has one place to be absorbed.
 *
 * Pure: it reads a Program and returns plain data.
 */

export interface TierView {
  key: TierCode;
  /** What the member sees. Also what Member.tier stores — the name is the code. */
  label: string;
  /** Progress euros at which the threshold is met. Tenure is a separate gate. */
  floor: number;
  minTenureMonths: number;
  /** Each paid euro adds this much progress while the member is in this tier. */
  multiplier: number;
  /** Cosmetics discount, 0 to 1. */
  discount: number;
}

export type MilestoneIssue =
  | {
      kind: "PREMIO";
      title: string;
      detail: { items: Array<{ id: string; name: string; value: number }>; value: number };
    }
  | {
      kind: "VENTAJA";
      title: string;
      detail: {
        perk: PerkKind;
        description: string;
        pool?: Array<{ id: string; name: string }>;
      };
    };

export interface MilestoneView {
  n: number;
  tramo: number;
  /** Progress euros at which it unlocks. */
  th: number;
  type: "premio" | "ventaja" | "nivel";
  tier?: TierCode;
  /** What is issued on crossing. Absent for a tier milestone: entering a tier grants no gift. */
  issue?: MilestoneIssue;
}

export interface ProgramView {
  tiers: TierView[];
  milestones: MilestoneView[];
  recurring: { every: number; startsAt: number; title: string };
  referral: Array<{ n: number; title: string; items: Array<{ id: string; name: string }> }>;
  /** Progress a referred client starts with. */
  welcome: number;
}

export const programView = (output: Program): ProgramView => {
  const levels = output.lad.ms.filter((m) => m.type === "nivel");

  // Bronce starts at zero; each later tier starts where the level milestone before it
  // sits. The ladder has exactly four, one between each pair of tiers.
  const floors = [0, ...levels.map((m) => m.th)];

  const tiers: TierView[] = TIERS.map((key, i) => ({
    key,
    label: TIER_NAMES[key],
    floor: floors[i] ?? Number.POSITIVE_INFINITY,
    minTenureMonths: MIN_TENURE[key],
    multiplier: TIER_BENEFITS[key].mult,
    discount: TIER_BENEFITS[key].discount
  }));

  const rewardAt = new Map(output.chosen.map((c) => [c.m.n, c]));

  const milestones: MilestoneView[] = output.lad.ms.map((m) => {
    const base: MilestoneView = { n: m.n, tramo: m.tramo, th: m.th, type: m.type, tier: m.tier };

    if (m.type === "premio") {
      const chosen = rewardAt.get(m.n);

      if (chosen) {
        base.issue = {
          kind: "PREMIO",
          title: rewardTitle(chosen),
          detail: {
            items: chosen.o.items.map((i) => ({ id: i.id, name: i.name, value: i.value })),
            value: chosen.o.value
          }
        };
      }
    }

    if (m.type === "ventaja" && m.perk) {
      base.issue = {
        kind: "VENTAJA",
        title: m.perk.name,
        detail: {
          perk: m.perk.kind,
          description: m.perk.desc,
          pool: m.perk.pool?.map((c) => ({ id: c.id, name: c.name }))
        }
      };
    }

    return base;
  });

  const diamond = tiers[tiers.length - 1].floor;

  return {
    tiers,
    milestones,
    recurring: { every: output.rec.every, startsAt: diamond, title: rewardTitle(output.rec) },
    referral: output.refLad.map((r) => ({
      n: r.n,
      title: r.name,
      items: r.o.items.map((i) => ({ id: i.id, name: i.name }))
    })),
    welcome: output.welcome
  };
};
