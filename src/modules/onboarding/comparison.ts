import { calcDefaults, simulate5y, type CalcInput, type CalcYear } from "./calculator";
import { run } from "./engine";
import { CONFIG_VERSION, ENGINE_VERSION } from "./engine.config";
import type { Answers, CatalogItem, Program } from "./engine.types";
import { isEngineError } from "./engine.types";
import { OnboardingError } from "./onboarding.service";

/**
 * What an edited programme is worth over five years against what the engine recommended.
 *
 * ADMIN ONLY. The admin swaps rewards freely now, so instead of refusing she is shown the money
 * consequence: the five-year cumulative net of the plan as it stands, and of the engine's own
 * recommendation for the same answers. Yearly totals only: no gift, cost or value of an individual
 * gift is in the result, and it is never sent to a centre's browser.
 *
 * The recommendation is the baseline stored with the draft (`output.recommended`). Only a row
 * made before that existed is replayed from its catalogue snapshot with TODAY's engine, which may
 * differ from the plan originally proposed, and says so in `reason`.
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
  /** A caveat about the recommendation, in English; null when it is the stored baseline. */
  reason: string | null;
}

const REBUILT =
  "Recommendation rebuilt with the current engine; it may differ from the plan originally proposed.";
const UNAVAILABLE =
  "The original recommendation could not be recalculated from the data stored with this programme.";

const euros = (n: number): number => Math.round(n);

const simulate = (program: Program, inputs: CalcInput): CalcYear[] | null => {
  try {
    const { years } = simulate5y(program, inputs, inputs);

    return years.length === 5 &&
      years.every((y) => Number.isFinite(y.net) && Number.isFinite(y.cumulativeNet))
      ? years
      : null;
  } catch {
    return null;
  }
};

/** The engine re-run on the stored snapshot, or null: never throws, a corrupt snapshot is just that. */
const replay = (catalogSnapshot: unknown, answers: Answers): Program | null => {
  if (!Array.isArray(catalogSnapshot) || catalogSnapshot.length === 0) return null;

  try {
    const result = run(catalogSnapshot as CatalogItem[], answers);

    // The engine's own refusal is written for the centre; here it only means "nothing to compare".
    return isEngineError(result) ? null : (result as Program);
  } catch {
    return null;
  }
};

export const compareFiveYears = (stored: {
  output: unknown;
  answers: unknown;
  catalogSnapshot: unknown;
  engineVersion?: string;
  configVersion?: string;
}): Comparison => {
  const current = stored.output as Program;
  const answers = stored.answers as Answers & { members?: string };
  let inputs: CalcInput;
  let now: CalcYear[] | null;

  try {
    // The CURRENT plan's calculator defaults, for both plans: the same clients and the same ticket,
    // so the difference between the two numbers is the plan and nothing else.
    inputs = calcDefaults(current, answers?.members);
    now = simulate(current, inputs);
  } catch {
    now = null;
    inputs = { clients: 0, ticket: 0 };
  }

  if (!now) {
    throw new OnboardingError(
      "The stored programme could not be compared: it cannot be simulated.",
      422
    );
  }

  let then: CalcYear[] | null = null;
  let reason: string | null = null;
  const baseline = current.recommended as Program | undefined;

  if (baseline && typeof baseline === "object") then = simulate(baseline, inputs);

  if (!then) {
    const rebuilt = replay(stored.catalogSnapshot, answers);

    then = rebuilt ? simulate(rebuilt, inputs) : null;

    if (!then) {
      reason = UNAVAILABLE;
    } else {
      const moved =
        (stored.engineVersion && stored.engineVersion !== ENGINE_VERSION) ||
        (stored.configVersion && stored.configVersion !== CONFIG_VERSION);

      reason = moved
        ? `${REBUILT} The programme was made with engine ${stored.engineVersion} and config ${stored.configVersion}; today it is engine ${ENGINE_VERSION} and config ${CONFIG_VERSION}.`
        : REBUILT;
    }
  }

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
