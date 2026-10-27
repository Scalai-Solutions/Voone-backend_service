import { MIN_TENURE, P, TIERS, TIER_BENEFITS, TIER_NAMES } from "./engine.config";
import type { Program, TierCode } from "./engine.types";
import { itemsTitle, rewardTitle } from "./reward-title";

/**
 * A programme as a centre is allowed to see it.
 *
 * The guide is explicit that costs are internal: "No costs and no revenue figures anywhere."
 * The engine's output is full of them — what each reward costs the centre, the share of
 * spend the programme consumes, the budget behind every milestone — and it is stored whole
 * because Voone needs it to audit a programme. So the screen a centre sees is built from
 * THIS, a projection that cannot leak a cost because it never reads one, rather than from
 * the stored output with fields deleted afterwards. Deleting is how a new cost field added
 * to the engine next year ends up on a centre's screen by accident.
 *
 * Pure. Everything in the result is plain data safe to serialise.
 */

/**
 * A gift, by name only.
 *
 * Neither what it costs the centre nor what it is worth at retail is here: the feedback is
 * explicit that a centre should see what it gives and what its clients spend, not what each gift
 * is worth. Value stays in the engine and the stored programme, because choosing rewards needs
 * it; it just never reaches this projection.
 */
export interface PresentedItem {
  name: string;
}

export interface PresentedMilestone {
  n: number;
  /** Which tier band it sits in, 1 to 4 — the ladder is shown grouped by band. */
  band: number;
  type: "premio" | "ventaja" | "nivel";
  /** Progress euros. Not shown to a centre: see `realSpend`. */
  threshold: number;
  /**
   * What a client has actually paid when she reaches this step. This is what the centre reads,
   * not `threshold`: progress runs ×1.1 in Oro, ×1.2 in Platino and ×1.3 in Diamante, so the two
   * diverge, and a row showing both would look like a mistake.
   */
  realSpend: number;
  /** Months for a typical repeating client to get here, at the programme's annual spend. */
  month: number;
  /** For a tier-up row: the tier entered. */
  tier?: { key: TierCode; label: string };
  reward?: {
    name: string;
    items: PresentedItem[];
    /** What the centre may swap this for without breaking the ladder. */
    alternatives: Array<{ name: string; items: PresentedItem[] }>;
  };
  perk?: { kind: string; name: string; description: string };
}

export interface PresentedTier {
  key: TierCode;
  label: string;
  /** What a client has paid when she enters this tier. */
  threshold: number;
  minTenureMonths: number;
  benefits: string[];
  /** The ones the centre wrote itself: the only ones it can add or remove. */
  customBenefits: string[];
}

export interface PresentedProgram {
  estimates: { segment: string; ticket: number; visitsPerYear: number; annualSpend: number };
  tiers: PresentedTier[];
  ladder: PresentedMilestone[];
  /** After Diamante: one reward for every `every` euros a client pays. */
  recurring: { every: number; name: string };
  /**
   * `minRevenue` is what the centre has earned at least from the people referred when the referrer
   * reaches this step: each one paid for a treatment, so each spent at least one average ticket.
   */
  referrals: Array<{ n: number; name: string; minRevenue: number }>;
  welcomeProgress: number;
  /** The separate, static tier outside the ladder. Shown as its own card. */
  familyAndFriends: { title: string; description: string; comingSoon: boolean };
  /** How the programme bent to fit the catalogue. Informational. */
  adaptations: string[];
  /** Real problems to resolve before approving. Blocking. */
  review: string[];
}

/**
 * The engine explains when a prize leans on more than its own budget. The centre has no use for
 * that: it is about how the programme was balanced, and it quotes the total cost, which stays
 * internal. The note stays in the engine's output; it is only not shown.
 */
const COST_NOTE_PREFIX = "Algunos premios usan algo más de su presupuesto individual";

const itemsOf = (items: Array<{ name: string }>): PresentedItem[] =>
  items.map((i) => ({ name: i.name }));

const pct = (share: number): string => `${Math.round(share * 100)}%`;

/** Benefits a tier carries permanently, in the order a client would care about them. */
const benefitsFor = (key: TierCode, program: Program): string[] => {
  const b = TIER_BENEFITS[key];
  const out: string[] = [];

  if (b.mult > 1) {
    out.push(`Cada euro suma ×${String(b.mult).replace(".", ",")} de progreso`);
  }

  if (b.discount > 0) {
    out.push(
      `Descuento del ${pct(b.discount)} en cosmética, hasta ${P.discountMaxProducts} productos al año`
    );
  }

  const gift = program.gifts[key]?.birthday;

  if (gift) out.push(`Regalo de cumpleaños: ${itemsTitle(gift.items)}`);

  if (b.events > 0) {
    out.push(
      b.events === 1 ? "Un evento exclusivo al año" : `${b.events} eventos exclusivos al año`
    );
  }

  if (b.tests) out.push("Prueba de nuevos tratamientos y aparatología");

  out.push(...b.extra);

  return out;
};

export const presentProgram = (program: Program): PresentedProgram => {
  const levels = program.lad.ms.filter((m) => m.type === "nivel");
  // Whole euros: a centre reads "826 €", and an unrounded real spend is a long float whose last
  // digits differ between the engine's output and the copy stored and read back.
  const euros = (n: number): number => Math.round(n);
  const floors = [0, ...levels.map((m) => euros(program.realTh[m.n]))];
  const monthOf = (real: number): number => Math.max(1, Math.round((real / program.est.A) * 12));
  const rewardAt = new Map(program.chosen.map((c) => [c.m.n, c]));

  return {
    estimates: {
      segment: program.est.segment,
      ticket: program.est.ticket,
      visitsPerYear: program.est.visits,
      annualSpend: program.est.A
    },

    tiers: TIERS.map((key, i) => ({
      key,
      label: TIER_NAMES[key],
      threshold: floors[i] ?? 0,
      minTenureMonths: MIN_TENURE[key],
      benefits: [...benefitsFor(key, program), ...(program.customBenefits?.[key] ?? [])],
      customBenefits: program.customBenefits?.[key] ?? []
    })),

    ladder: program.lad.ms.map((m): PresentedMilestone => {
      const real = program.realTh[m.n];
      const base: PresentedMilestone = {
        n: m.n,
        band: m.tramo,
        type: m.type,
        threshold: m.th,
        realSpend: euros(real),
        month: monthOf(real)
      };

      if (m.type === "nivel" && m.tier) base.tier = { key: m.tier, label: TIER_NAMES[m.tier] };

      const chosen = rewardAt.get(m.n);

      if (m.type === "premio" && chosen) {
        base.reward = {
          name: rewardTitle(chosen),
          items: itemsOf(chosen.o.items),
          alternatives: chosen.alts.map((a) => ({
            name: itemsTitle(a.items),
            items: itemsOf(a.items)
          }))
        };
      }

      if (m.type === "ventaja" && m.perk) {
        base.perk = { kind: m.perk.kind, name: m.perk.name, description: m.perk.desc };
      }

      return base;
    }),

    recurring: {
      // Progress runs ×1.3 in Diamante, so a reward every `every` of progress is one every
      // `every / 1.3` euros actually paid, and the euros paid are what a centre reads.
      every: Math.round(program.rec.every / TIER_BENEFITS.diamante.mult),
      name: rewardTitle(program.rec)
    },

    referrals: program.refLad.map((r) => ({
      n: r.n,
      name: r.name,
      minRevenue: r.n * program.est.ticket
    })),

    welcomeProgress: program.welcome,

    familyAndFriends: {
      title: "Family & Friends",
      description: "Un nivel aparte para las personas cercanas al centro.",
      // Not available yet: the card stays visible so centres know it is coming.
      comingSoon: true
    },

    adaptations: program.adapt.filter((note) => !note.startsWith(COST_NOTE_PREFIX)),
    review: program.review
  };
};
