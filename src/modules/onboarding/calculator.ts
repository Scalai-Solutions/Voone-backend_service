import { CALC, MEMBER_BUCKETS } from "./calculator.config";
import { TIERS, TIER_BENEFITS } from "./engine.config";
import type { Program, TierCode } from "./engine.types";

/**
 * What a programme costs and brings in over five years, for the number of clients and the
 * ticket a centre types in.
 *
 * Always against the programme it is given: nothing here chooses or changes a threshold, a
 * reward or a perk. The ticket only changes how much the simulated clients spend and so how fast
 * they climb the ladder that already exists.
 *
 * It runs on the server because it needs what every reward costs the centre, and the guide is
 * explicit that those figures never reach a centre's browser. Only yearly totals leave this
 * function — never the cost or value of an individual gift.
 *
 * Pure and deterministic, and cheap: 60 months by two client types.
 */

export interface CalcInput {
  /** Members the centre expects to have in the programme once onboarding is complete. */
  clients: number;
  /** Euros per visit. */
  ticket: number;
}

export interface CalcLine {
  key: string;
  label: string;
  amount: number;
}

export interface CalcYear {
  year: number;
  avgMembers: number;
  /** Members at the end of the year, by tier. */
  byTier: Record<TierCode, number>;
  generates: { total: number; lines: CalcLine[] };
  costs: { total: number; lines: CalcLine[] };
  net: number;
  cumulativeNet: number;
}

export interface CalcResult {
  input: CalcInput;
  /** The defaults the screen pre-fills, so it can offer to reset to them. */
  defaults: CalcInput;
  years: CalcYear[];
}

export type CalcError = { error: string };

const zeroTiers = (): Record<TierCode, number> => ({
  bronce: 0,
  plata: 0,
  oro: 0,
  platino: 0,
  diamante: 0
});

/** The clients a centre starts from: its own answer, scaled by how many are expected to join. */
export const defaultClients = (members: string | undefined): number =>
  Math.max(
    CALC.clients.min,
    Math.round((MEMBER_BUCKETS[members ?? "m3"] ?? MEMBER_BUCKETS.m3) * CALC.adhesion)
  );

export const calcDefaults = (program: Program, members: string | undefined): CalcInput => ({
  clients: defaultClients(members),
  ticket: program.est.ticket
});

/** What a tier gives a client over a year, apart from rewards. */
const tierYearCost = (program: Program, tier: TierCode, annualSpend: number): number => {
  const b = TIER_BENEFITS[tier];
  const birthday = program.gifts[tier]?.birthday?.cost ?? 0;
  const events = b.events * CALC.eventCost * CALC.eventAttendance;
  const tests = b.tests ? CALC.testCost : 0;
  // A discount applies to cosmetics bought, which is a share of what the client spends.
  const discount = b.discount * CALC.cosmeticShareOfSpend * annualSpend * b.mult;

  return birthday + events + tests + discount;
};

interface ClientType {
  key: "rep" | "occ";
  share: number;
  annual: number;
  retention: number;
  /** Share of a tier's standing benefits that this type actually uses. */
  benefitShare: number;
}

interface Cohort {
  type: ClientType;
  join: number;
  size: number;
}

export const validateCalcInput = (input: CalcInput): string | null => {
  if (
    !Number.isFinite(input.clients) ||
    input.clients < CALC.clients.min ||
    input.clients > CALC.clients.max
  ) {
    return `Los clientes tienen que estar entre ${CALC.clients.min} y ${CALC.clients.max}.`;
  }

  if (
    !Number.isFinite(input.ticket) ||
    input.ticket < CALC.ticket.min ||
    input.ticket > CALC.ticket.max
  ) {
    return `El ticket medio tiene que estar entre ${CALC.ticket.min} y ${CALC.ticket.max} €.`;
  }

  return null;
};

export const simulate5y = (
  program: Program,
  input: CalcInput,
  defaults: CalcInput = input
): CalcResult => {
  const months = CALC.years * 12;
  const visits = program.est.visits;
  const repeaterAnnual = input.ticket * visits;
  const occasionalAnnual = CALC.occVisits * input.ticket;
  const repeaterShare = Math.min(0.95, CALC.repeatShare + CALC.uplift);

  const types: ClientType[] = [
    {
      key: "rep",
      share: repeaterShare,
      annual: repeaterAnnual,
      retention: CALC.repeatRetention,
      benefitShare: 1
    },
    {
      key: "occ",
      share: 1 - repeaterShare,
      annual: occasionalAnnual,
      retention: CALC.occRetention,
      benefitShare: CALC.occBenefitShare
    }
  ];

  // The ladder, in real euros: what a client has actually paid when she reaches each step.
  const ladder = program.lad.ms.map((m) => ({
    real: program.realTh[m.n],
    tier: m.type === "nivel" ? m.tier : undefined,
    cost:
      m.type === "premio"
        ? (program.chosen.find((c) => c.m.n === m.n)?.o.cost ?? 0)
        : m.type === "ventaja"
          ? (m.perk?.cost ?? 0)
          : 0,
    counts: m.type !== "nivel"
  }));
  const levels = ladder.filter((l) => l.tier);
  const diamondReal = program.realTh[program.lad.last.n];
  const diamondMult = TIER_BENEFITS.diamante.mult;

  const tierAt = (spend: number): TierCode => {
    let tier: TierCode = "bronce";

    for (const level of levels) if (level.real <= spend + 1e-9) tier = level.tier as TierCode;

    return tier;
  };

  const benefitPerMonth = new Map<string, number>();

  for (const type of types) {
    for (const tier of TIERS) {
      benefitPerMonth.set(
        `${type.key}:${tier}`,
        (tierYearCost(program, tier, repeaterAnnual) * type.benefitShare) / 12
      );
    }
  }

  const cohorts: Cohort[] = [];
  const perYear = Array.from({ length: CALC.years }, () => ({
    memberMonths: 0,
    repeaterMonths: 0,
    rewardCost: 0,
    redemptions: 0,
    benefitCost: 0,
    byTier: zeroTiers()
  }));

  const aliveAt = (cohort: Cohort, month: number): number =>
    cohort.size * Math.pow(cohort.type.retention, (month - cohort.join) / 12);

  for (let month = 1; month <= months; month += 1) {
    const year = Math.ceil(month / 12) - 1;
    const bucket = perYear[year];

    // Onboarding is linear over the first year; after that every client who leaves is replaced.
    const target = Math.min(input.clients, (input.clients * month) / 12);
    const survivors = cohorts.reduce((sum, c) => sum + aliveAt(c, month), 0);
    const joiners = Math.max(0, target - survivors);

    for (const type of types) cohorts.push({ type, join: month, size: joiners * type.share });

    const tiersNow = zeroTiers();

    for (const cohort of cohorts) {
      const alive = aliveAt(cohort, month);

      if (alive <= 0) continue;

      const age = month - cohort.join;
      const spend = ((age + 1) * cohort.type.annual) / 12;
      const before = (age * cohort.type.annual) / 12;
      const tier = tierAt(spend);

      tiersNow[tier] += alive;
      bucket.memberMonths += alive;
      if (cohort.type.key === "rep") bucket.repeaterMonths += alive;
      bucket.benefitCost += alive * (benefitPerMonth.get(`${cohort.type.key}:${tier}`) ?? 0);

      // A reward or perk is counted in the month a cohort reaches it, at what it costs the centre.
      for (const step of ladder) {
        if (step.counts && before < step.real - 1e-9 && spend >= step.real - 1e-9) {
          bucket.rewardCost += alive * step.cost * CALC.redemption;
          bucket.redemptions += alive * CALC.redemption;
        }
      }

      // Past Diamante, a reward comes round every so often, counted as progress is earned.
      const over = Math.max(0, spend - Math.max(before, diamondReal));

      if (over > 0) {
        const rewards = (over * diamondMult) / program.rec.every;

        bucket.rewardCost += alive * rewards * program.rec.o.cost * CALC.redemption;
        bucket.redemptions += alive * rewards * CALC.redemption;
      }
    }

    if (month % 12 === 0) bucket.byTier = tiersNow;
  }

  const newClientYear =
    CALC.repeatShare * repeaterAnnual + (1 - CALC.repeatShare) * occasionalAnnual;
  const referralRewardCost = program.refLad[0]?.o.cost ?? 0;
  const fee = CALC.feeBySegment[program.est.segment] * 12;

  let cumulative = 0;

  const result: CalcYear[] = perYear.map((y, index) => {
    const avgMembers = y.memberMonths / 12;
    const referred = avgMembers * CALC.refShare;

    const generatesLines: CalcLine[] = [
      {
        key: "repeat",
        label: "Clientes que empiezan a repetir",
        amount:
          avgMembers * (repeaterShare - CALC.repeatShare) * (repeaterAnnual - occasionalAnnual)
      },
      {
        key: "spend",
        label: "Las que repiten gastan algo más",
        amount: (y.repeaterMonths / 12) * repeaterAnnual * CALC.spendUplift
      },
      {
        key: "redeem",
        label: "Canjes que traen una visita de pago",
        amount: y.redemptions * CALC.redeemVisitShare * input.ticket
      },
      {
        key: "referred",
        label: "Clientes nuevos por recomendación",
        amount: referred * newClientYear
      }
    ];

    const costLines: CalcLine[] = [
      { key: "rewards", label: "Premios y ventajas canjeados", amount: y.rewardCost },
      { key: "tiers", label: "Ventajas de nivel", amount: y.benefitCost },
      {
        key: "referrals",
        label: "Premios de recomendación y progreso de bienvenida",
        amount:
          referred * (referralRewardCost * CALC.redemption + program.welcome * program.costPct)
      },
      { key: "fee", label: "Cuota de Voone", amount: fee }
    ];

    const generates = generatesLines.reduce((s, l) => s + l.amount, 0);
    const costs = costLines.reduce((s, l) => s + l.amount, 0);

    cumulative += generates - costs;

    return {
      year: index + 1,
      avgMembers,
      byTier: y.byTier,
      generates: { total: generates, lines: generatesLines },
      costs: { total: costs, lines: costLines },
      net: generates - costs,
      cumulativeNet: cumulative
    };
  });

  return { input, defaults, years: result };
};
