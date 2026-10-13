# Onboarding engine

Turns a centre's catalogue plus six answers into a complete loyalty programme: tier
thresholds, a ladder of rewards drawn from the centre's own price list, interleaved
perks, a recurring reward after Diamante, birthday gifts and a referral ladder.

A pure function. No I/O, no clock, no randomness, no database. `run(catalog, answers)`
returns either a `Program` or an `EngineError` with a Spanish sentence the centre can act
on.

```ts
import { run } from "./engine";
import { isEngineError } from "./engine.types";

const result = run(catalogRows, {
  ticket: null, // null means "use your own estimate"
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2"
});

if (isEngineError(result)) {
  // Show result.error to the centre. Nothing was generated.
} else {
  // result.review must be empty before the centre can approve.
}
```

## Files

| File               | What it holds                                                           |
| ------------------ | ----------------------------------------------------------------------- |
| `engine.ts`        | The nine-step pipeline and the relaxation cascade                       |
| `engine.config.ts` | Every number, versioned. Recalibrating is a config change, not a deploy |
| `engine.math.ts`   | Rounding, median, option building and the tie-break comparators         |
| `engine.types.ts`  | The vocabulary                                                          |

## The reference implementation is the specification

This is a port of `engine.cjs` v1.2.0, which the partners validated against a spreadsheet.
A copy lives in `tests/onboarding/reference/`, vendored verbatim and excluded from both
ESLint and Prettier so it stays byte-identical to what they signed off.

`tests/onboarding/engine.differential.test.ts` runs both engines over all 48
objective/investment/occupancy combinations, over bucket overrides, and over edge
catalogues, and asserts the output is identical. **If the two ever disagree, this port is
wrong.** Do not "fix" the reference to match.

When the partners send a new drop, diff it against the vendored copy before touching
anything here: the diff is the changelog.

## What is deliberately not ported

The reference also computes an internal revenue projection — member counts, retention,
fees, net year — which feeds a sales simulator. The implementation guide says not to port
or expose it, so none of it is here. Item `cost` is kept, because reward selection depends
on it.

The `members` answer is accepted and ignored for the same reason. Store it with the centre
profile; it changes nothing about the programme.

## Decisions and open questions

Every question raised while porting the guide, and the approach taken for each while waiting
for an answer, is recorded in **`docs/onboarding-decisions.md`**: the three errors found in
the guide, the guide's seven open questions, and ten further decisions made while building.
The provisional answers are also collected in one file, `runtime/decisions.ts`, so the people
who own them can find and change each one.

Where the guide contradicts the code that existed before it, the guide won. Where it
contradicts itself, the reference implementation won.

## What exists

| Layer                | Files                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Engine (pure)        | `engine.ts`, `engine.config.ts`, `engine.math.ts`, `engine.types.ts`, `swap.ts`                |
| Storage              | `catalog.repository.ts`, `onboarding.service.ts` (`CatalogItem`, `OnboardingProgram`)          |
| Presentation         | `presentation.ts` — a programme with **no cost figures**, by construction                      |
| Import               | `catalog-csv.ts` — `;` or tab, bad rows skipped and reported                                   |
| Runtime rules (pure) | `runtime/rules.ts`, `runtime/program-view.ts`, `runtime/decisions.ts`                          |
| Runtime services     | `runtime/visit.service.ts`, `reward.service.ts`, `referral.service.ts`, `program-tier.port.ts` |
| HTTP                 | `src/routes/v1/onboarding.route.ts`                                                            |

A clinic opts in by **publishing** a programme. Until it does, every code path is the one that
existed before: `PointsService` asks `ProgramTierPort`, gets `null`, and applies the legacy
rules unchanged.

## What is not built

See Part D of `docs/onboarding-decisions.md`. In short: the frontend wizard, birthday gifts
(only a birth year is stored), the Family & Friends list, Happy Hour slot flagging, and a bulk
re-tiering of existing members when a clinic publishes.
