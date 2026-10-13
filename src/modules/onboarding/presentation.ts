import { MIN_TENURE, P, TIERS, TIER_BENEFITS, TIER_NAMES } from "./engine.config";
import type { Program, TierCode } from "./engine.types";

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

export interface PresentedItem {
  name: string;
  /** What the client perceives: the sale price. Never what it costs the centre. */
  value: number;
}

export interface PresentedMilestone {
  n: number;
  /** Which tier band it sits in, 1 to 4 — the ladder is shown grouped by band. */
  band: number;
  type: "premio" | "ventaja" | "nivel";
  /** Progress euros. */
  threshold: number;
  /** For a tier-up row: the tier entered. */
  tier?: { key: TierCode; label: string };
  reward?: {
    name: string;
    value: number;
    items: PresentedItem[];
    /** What the centre may swap this for without breaking the ladder. */
    alternatives: Array<{ name: string; value: number; items: PresentedItem[] }>;
  };
  perk?: { kind: string; name: string; description: string };
}

export interface PresentedTier {
  key: TierCode;
  label: string;
  /** Progress euros at which the threshold is met. */
  threshold: number;
  minTenureMonths: number;
  benefits: string[];
}

export interface PresentedProgram {
  estimates: { segment: string; ticket: number; visitsPerYear: number; annualSpend: number };
  tiers: PresentedTier[];
  ladder: PresentedMilestone[];
  recurring: { every: number; name: string; value: number };
  referrals: Array<{ n: number; name: string; value: number }>;
  welcomeProgress: number;
  /** The separate, static tier outside the ladder. Shown as its own card. */
  familyAndFriends: { title: string; description: string };
  /** How the programme bent to fit the catalogue. Informational. */
  adaptations: string[];
  /** Real problems to resolve before approving. Blocking. */
  review: string[];
}

const itemsOf = (items: Array<{ name: string; value: number }>): PresentedItem[] =>
  items.map((i) => ({ name: i.name, value: i.value }));

const nameOf = (items: Array<{ name: string }>): string => items.map((i) => i.name).join(" y ");

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

  if (gift) out.push(`Regalo de cumpleaños: ${nameOf(gift.items)}`);

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
  const floors = [0, ...levels.map((m) => m.th)];
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
      benefits: benefitsFor(key, program)
    })),

    ladder: program.lad.ms.map((m): PresentedMilestone => {
      const base: PresentedMilestone = { n: m.n, band: m.tramo, type: m.type, threshold: m.th };

      if (m.type === "nivel" && m.tier) base.tier = { key: m.tier, label: TIER_NAMES[m.tier] };

      const chosen = rewardAt.get(m.n);

      if (m.type === "premio" && chosen) {
        base.reward = {
          name: nameOf(chosen.o.items),
          value: chosen.o.value,
          items: itemsOf(chosen.o.items),
          alternatives: chosen.alts.map((a) => ({
            name: nameOf(a.items),
            value: a.value,
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
      every: program.rec.every,
      name: nameOf(program.rec.o.items),
      value: program.rec.o.value
    },

    referrals: program.refLad.map((r) => ({ n: r.n, name: r.name, value: r.o.value })),

    welcomeProgress: program.welcome,

    familyAndFriends: {
      title: "Family & Friends",
      description:
        "Un nivel aparte para las personas cercanas al centro. El centro las añade a mano y define sus ventajas. No acumulan progreso, no tienen hitos y no suben de nivel."
    },

    adaptations: program.adapt,
    review: program.review
  };
};
