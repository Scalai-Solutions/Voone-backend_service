import { calcDefaults, simulate5y, type CalcInput, type CalcYear } from "./calculator";
import { run } from "./engine";
import type { Answers, CatalogItem, Program } from "./engine.types";
import { isEngineError } from "./engine.types";

/**
 * What an edited programme is worth over five years against what the engine recommended.
 *
 * ADMIN ONLY. The admin swaps rewards freely now, so instead of refusing she is shown the money
 * consequence: the five-year cumulative net of the plan as it stands, and of the engine's own
 * recommendation for the same answers and the same catalogue snapshot (re-run, which is
 * deterministic). Yearly totals only: no gift, cost or value of an individual gift is in the
 * result, and it is never sent to a centre's browser.
 */

export interface ComparisonYear {
  year: number;
  recommendedNet: number | null;
  currentNet: number;
  recommendedCumulative: number | null;
  currentCumulative: number;
}

export interface Comparison {
  inputs: CalcInput;
  /** Cumulative net after year five, whole euros; null when there is no recommendation to compare. */
  recommendedNet5y: number | null;
  currentNet5y: number;
  /** `currentNet5y - recommendedNet5y`: negative means the edited plan earns less. */
  delta: number | null;
  years: ComparisonYear[];
  /** Why there is no recommendation, in Spanish; null when there is one. */
  reason: string | null;
}

const NO_RECOMMENDATION =
  "No se ha podido recalcular la recomendación original con los datos guardados de este programa.";

const euros = (n: number): number => Math.round(n);

/** The recommendation, or null with the reason: never throws, a corrupt snapshot is just that. */
const recommend = (
  catalogSnapshot: unknown,
  answers: Answers
): { program: Program } | { reason: string } => {
  if (!Array.isArray(catalogSnapshot) || catalogSnapshot.length === 0) {
    return { reason: NO_RECOMMENDATION };
  }

  try {
    const result = run(catalogSnapshot as CatalogItem[], answers);

    // The engine's own refusal is written for the centre; here it only means "nothing to compare".
    if (isEngineError(result)) return { reason: NO_RECOMMENDATION };

    return { program: result as Program };
  } catch {
    return { reason: NO_RECOMMENDATION };
  }
};

const simulate = (program: Program, inputs: CalcInput): CalcYear[] | null => {
  try {
    const { years } = simulate5y(program, inputs, inputs);

    return years.every((y) => Number.isFinite(y.net) && Number.isFinite(y.cumulativeNet))
      ? years
      : null;
  } catch {
    return null;
  }
};

export const compareFiveYears = (stored: {
  output: unknown;
  answers: unknown;
  catalogSnapshot: unknown;
}): Comparison => {
  const current = stored.output as Program;
  const answers = stored.answers as Answers & { members?: string };
  // The CURRENT plan's calculator defaults, for both plans: the same clients and the same ticket,
  // so the difference between the two numbers is the plan and nothing else.
  const inputs = calcDefaults(current, answers?.members);
  const now = simulate(current, inputs);

  if (!now) throw new Error("The stored programme could not be simulated.");

  const picked = recommend(stored.catalogSnapshot, answers);
  const then = "program" in picked ? simulate(picked.program, inputs) : null;
  const reason = then ? null : "reason" in picked ? picked.reason : NO_RECOMMENDATION;
  const currentNet5y = euros(now[4].cumulativeNet);
  const recommendedNet5y = then ? euros(then[4].cumulativeNet) : null;

  return {
    inputs,
    recommendedNet5y,
    currentNet5y,
    delta: recommendedNet5y === null ? null : currentNet5y - recommendedNet5y,
    years: now.map((y, i) => ({
      year: y.year,
      recommendedNet: then ? euros(then[i].net) : null,
      currentNet: euros(y.net),
      recommendedCumulative: then ? euros(then[i].cumulativeNet) : null,
      currentCumulative: euros(y.cumulativeNet)
    })),
    reason
  };
};
