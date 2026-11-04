/**
 * Pure presenters for the change-request "what if" flag. They turn five yearly cumulative-net
 * figures into the owner's deliberately blurred flag (marks, euros to the nearest 100, percents
 * to the nearest 5) and the admin's exact flag (whole euros, percent to one decimal).
 *
 * Pure on purpose: no I/O, no clock, no randomness, inputs are never mutated. The owner flag must
 * never carry an exact figure, a cost, or the recommended plan's own numbers.
 */

export interface WhatIfYear {
  year: number;
  liveCumulative: number;
  proposedCumulative: number;
  recommendedCumulative: number | null;
}

export type Mark = "up" | "same" | "down";

export interface OwnerCell {
  year: number;
  mark: Mark;
  euros: number | null;
  percent: number | null;
  over20: boolean;
}

export type OwnerFlag =
  | {
      status: "ok";
      signal: "good" | "costs-more" | "similar";
      vsCurrent: OwnerCell[];
      vsRecommended: OwnerCell[] | null;
      fiveYearEuros: number | null;
    }
  | { status: "unpriced" }
  | { status: "blocked"; kind: "repeat" | "unavailable" }
  | { status: "none" };

/** Exact: whole euros, percent to one decimal. */
export interface AdminCell {
  year: number;
  euros: number;
  percent: number | null;
}

export interface AdminFlag {
  status: "ok";
  inputs: { clients: number; ticket: number };
  years: Array<{
    year: number;
    live: number;
    proposed: number;
    recommended: number | null;
    vsLive: AdminCell;
    vsRecommended: AdminCell | null;
  }>;
  reason: string | null;
}

/** A baseline smaller than this (in absolute euros) is too small to express as a percent. */
const PERCENT_MIN_BASELINE = 500;
/** Relative changes under 2% read as "the same". */
const SAME_PCT = 0.02;
/** Without a percent, absolute changes under 100 euros read as "the same". */
const SAME_EUROS = 100;
const OVER_PCT = 0.2;
/** Absorbs binary floating point noise so an exact .5 still rounds away from zero. */
const EPSILON = 1e-9;

/** Round half away from zero; never returns negative zero. */
const roundHalfAway = (value: number): number => {
  const rounded = Math.sign(value) * Math.round(Math.abs(value) + EPSILON);
  return rounded === 0 ? 0 : rounded;
};

const pctOf = (delta: number, baseline: number): number | null =>
  Math.abs(baseline) >= PERCENT_MIN_BASELINE ? delta / Math.abs(baseline) : null;

const markOf = (delta: number, pct: number | null): Mark => {
  if (pct !== null) {
    if (Math.abs(pct) < SAME_PCT) return "same";
    return pct > 0 ? "up" : "down";
  }
  if (Math.abs(delta) < SAME_EUROS) return "same";
  return delta > 0 ? "up" : "down";
};

const ownerCell = (year: number, baseline: number, proposed: number): OwnerCell => {
  const delta = proposed - baseline;
  const pct = pctOf(delta, baseline);
  const euros = roundHalfAway(delta / 100) * 100;
  // A cell whose rounded euros come to 0 reads as "same": the owner is never shown an
  // up/down mark with nothing to say about it.
  const mark = euros === 0 ? "same" : markOf(delta, pct);
  if (mark === "same") {
    return { year, mark, euros: null, percent: null, over20: false };
  }
  return {
    year,
    mark,
    euros,
    percent: pct === null ? null : roundHalfAway((pct * 100) / 5) * 5,
    over20: pct !== null && Math.abs(pct) > OVER_PCT
  };
};

const adminCell = (year: number, baseline: number, proposed: number): AdminCell => {
  const delta = proposed - baseline;
  const pct = pctOf(delta, baseline);
  return {
    year,
    euros: roundHalfAway(delta),
    percent: pct === null ? null : roundHalfAway(pct * 100 * 10) / 10
  };
};

export const presentOwnerFlag = (years: WhatIfYear[]): Extract<OwnerFlag, { status: "ok" }> => {
  if (years.length === 0) {
    throw new Error("presentOwnerFlag needs at least one year");
  }
  const vsCurrent = years.map((y) => ownerCell(y.year, y.liveCumulative, y.proposedCumulative));
  const hasRecommended = years.every((y) => y.recommendedCumulative !== null);
  const vsRecommended = hasRecommended
    ? years.map((y) => ownerCell(y.year, y.recommendedCumulative as number, y.proposedCumulative))
    : null;

  // The last year is year 5: the signal and headline figure come from it, against the live plan.
  const last = vsCurrent[vsCurrent.length - 1]!;
  const signal = last.mark === "up" ? "good" : last.mark === "down" ? "costs-more" : "similar";

  return {
    status: "ok",
    signal,
    vsCurrent,
    vsRecommended,
    fiveYearEuros: last.mark === "same" ? null : last.euros
  };
};

export const presentAdminFlag = (
  years: WhatIfYear[],
  inputs: { clients: number; ticket: number },
  reason: string | null
): AdminFlag => ({
  status: "ok",
  inputs: { clients: inputs.clients, ticket: inputs.ticket },
  years: years.map((y) => ({
    year: y.year,
    live: roundHalfAway(y.liveCumulative),
    proposed: roundHalfAway(y.proposedCumulative),
    recommended: y.recommendedCumulative === null ? null : roundHalfAway(y.recommendedCumulative),
    vsLive: adminCell(y.year, y.liveCumulative, y.proposedCumulative),
    vsRecommended:
      y.recommendedCumulative === null
        ? null
        : adminCell(y.year, y.recommendedCumulative, y.proposedCumulative)
  })),
  reason
});
