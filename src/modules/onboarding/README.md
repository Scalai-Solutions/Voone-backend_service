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

## Known discrepancies in the implementation guide

Found while porting, raised with Sergio, not yet resolved. The reference wins in each
case, because it is the specification.

1. **The sweep test cannot pass as written.** The guide says all 48 answer combinations
   should return a programme with no review notes and every guarantee true. Against the
   reference, 10 of 48 have a false guarantee and 5 raise a review note.
2. **The Bronce reorder can break the no-consecutive-repeat guarantee.** The beam search
   forbids an item appearing in two consecutive rewards, but v1.2 then reorders the first
   segment so its best reward leads. That reordering can move a repeat into adjacency.
   All five failures start at the same place, the first-to-second reward of segment 1.
3. **Welcome progress is 15 for the fixture, not 25.** The guide's expected-values table
   says 25; its own stated formula — half the first milestone threshold, rounded to the
   nearest 5 — gives 15, because that threshold is 30. `sapphira.expected.json` carries no
   `welcome` field, so the prescribed fixture test cannot catch it.

## Storage

`CatalogItem` holds a centre's price list; `OnboardingProgram` holds a generated
programme with the answers and the catalogue snapshot that produced it.

**`CatalogItem` is separate from `ClinicTreatment` for a structural reason, not a
stylistic one.** The engine's determinism rests on stable item ids — they are the final
tie-break in every sort — and `treatmentsRepository.replaceForClinic` deletes every row
and recreates it on each template save, minting fresh uuids. A catalogue stored there
would generate a different ladder after an unrelated edit to the card's copy.

The duplication is meant to be temporary. `ClinicTreatment.pointsAllotted` is a
per-treatment points award that the engine's progress-in-euros model replaces outright;
when the wizard is rewritten, `ClinicTreatment` should be retired and its two readers —
the staff credit screen and the template flow — moved onto `CatalogItem`. Until then,
which table a screen reads must be a deliberate choice.

Prices are stored in cents. The engine does float arithmetic on euros, and a decimal
column read back as a float is how a ladder ends up differing by a cent and therefore by
a tie-break.

## Not wired up yet

No route calls any of this, and no existing points, tier, wallet or notification path has
been changed. `OnboardingService` can generate, store and publish a programme; nothing
reads a published one yet, so members still earn against `ClinicTemplate.tierRewards`.

Still to come: HTTP routes, CSV import, issued rewards with expiry and the paid-visit
redemption gate, referral counting, and the wizard rewrite. Switching the points and tier
engines over to a published programme is the step that needs the most care — it changes
what every existing member's balance means. The runtime rules in section 6 of the guide —
tenure gates, 60-day expiry, progress multipliers — are the product's job, not the
engine's.
