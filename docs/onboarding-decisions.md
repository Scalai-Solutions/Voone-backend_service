# Onboarding engine: decisions and open questions

This records every question raised while porting the **Voone Onboarding Engine
Implementation Guide** (6 Oct 2026, Sergio) and the reference implementation
`engine.cjs` v1.2.0, and the approach taken for each **while waiting for an answer**.

**How to read it.** Each entry has the question, where it came from, what is implemented,
where it lives in the code, and what it would take to change. Nothing here is final: every
"approach implemented" is a recommendation chosen so that building could continue, and each
can be reversed.

**Precedence.** Where the guide contradicts the code that existed before it, the guide won.
Where the guide contradicts itself, the executable reference (`engine.cjs`) won, because it is
what the partners validated against their spreadsheet. A copy of the reference lives in
`tests/onboarding/reference/` and is compared against the port by the test suite.

| #      | Question                                         | Status                                            |
| ------ | ------------------------------------------------ | ------------------------------------------------- |
| A1     | Two Bronce rules contradict each other           | Resolved in code, **needs Sergio's confirmation** |
| A2     | The guide's sweep test cannot pass               | Resolved in code, **needs Sergio's confirmation** |
| A3     | Welcome progress is 15, not 25                   | Resolved in code, confirm                         |
| B1     | How does a payment reach Voone?                  | Staff entry built; others reserved                |
| B2     | Who chooses a surprise reward's item?            | Built: staff, from the pool                       |
| B3     | When does tenure start?                          | Built: from sign-up                               |
| B4     | Is the 3-product limit calendar-year or rolling? | Built: calendar year                              |
| B5     | Is progress shared across a group of centres?    | Decided: per centre                               |
| B6     | Is recalibration automatic or prompted?          | Built: prompted                                   |
| B7     | What does "leave a rating" mean?                 | Decided: nothing earns from a review              |
| C1–C10 | Further decisions found while building           | See Part C                                        |
| D      | What is **not** built                            | See Part D                                        |
| E1–E12 | The frontend: wizard, staff screens, safety      | See Part E                                        |
| F1–F9  | Founders' feedback, round 1                      | See Part F                                        |

---

## Part A: errors found in the guide

### A1. Two Bronce rules contradict each other

**Question for Sergio.** The guide asks for both of these:

- No gift repeats in two milestones in a row.
- New in v1.2: in Bronce, the best reward comes first.

When a catalogue is small, both cannot hold at once. Which rule should win?

**What was found.** In 5 of the 48 objective/investment/occupancy combinations the reference
engine breaks the first rule: `equilibrado/conservador/o4`, `mas_visitas/conservador/o4`,
`mas_gasto/conservador/o3`, `mas_gasto/conservador/o4`, `mas_clientes_nuevos/conservador/o4`.
Disabling only the Bronce reorder in a copy of the reference removes all five. In every
failing case the three Bronce rewards are **tied at 20 €**, so "best first" meant nothing and
the reorder changed nothing except creating the repeat.

**Approach implemented.** The no-repeat rule wins, because a gift offered twice running reads
as a mistake while an unusual Bronce order is invisible. `orderBronce` reorders only where it
changes which reward leads; tries the guide's exact order, then a second safe order; checks
the boundary with the next segment as well as inside Bronce; and otherwise keeps the beam
search's order and adds a Spanish adaptation note.

**Measured.** The five failures became zero. A 400-run fuzz over random sub-catalogues found
no refusals and no exceptions, but showed the two rules cannot both hold in about 2% of
catalogues (8 of 400), and in one real fixture combination under a ticket override. In those
cases the Bronce guarantee reads false and the note says why.

**Where.** `src/modules/onboarding/engine.ts` (`orderBronce`);
`tests/onboarding/bronce-order.test.ts`; the one permitted deviation from the reference is
asserted in `tests/onboarding/engine.differential.test.ts`.

**To change.** If the Bronce rule should win instead, change the order in which
`orderBronce` tries arrangements; the tests state exactly which guarantees must hold.

### A2. The guide's sweep test cannot pass

**Question for Sergio.** Section 7 says all 48 combinations should return "a program with no
error and no review notes", every guarantee true. Is a tenth of a point over the cost ceiling
acceptable?

**What was found.** Against the reference, 10 of 48 have a false guarantee. Five are A1. The
other five exceed the cost ceiling by a hair (6.1% against a 6% cap; 9.1% against 9%), all on
a busy agenda where the chair-time multiplier inflates gift cost: `equilibrado/conservador/o3`,
`mas_clientes_nuevos/conservador/o3`, `equilibrado/generoso/o4`, `mas_visitas/generoso/o4`,
`mas_clientes_nuevos/generoso/o4`. The guide's own rules say a cost above 1.5× the chosen
investment raises a blocking review note, so the test contradicts the rules.

**Approach implemented.** The rules are the specification, so the test was reworded to what is
actually required: nothing throws, and wherever a guarantee is false a review note says why.
The five cost cases are pinned **by name** so a recalibration that changes the set is noticed.
The cost ceiling itself is unchanged; those five combinations produce a blocking note that
tells the centre to raise the investment or add cheaper gifts.

**Where.** `tests/onboarding/engine.sweep.test.ts`.

**To change.** To allow a tolerance, change the `1.5` in `engine.ts` (`costPct > lad.inv * 1.5`
and the matching guarantee) and update the pinned set.

### A3. Welcome progress is 15, not 25

**Question for Sergio.** The expected-values table says a referred client starts with 25 €.
The reference gives 15, and so does the guide's own formula ("half of the first milestone
threshold, rounded to the nearest 5"): the first milestone is 30, not 50.

**Approach implemented.** 15, following the reference and the formula. `sapphira.expected.json`
carries no `welcome` field, so the fixture test the guide prescribes cannot catch this number;
it is asserted explicitly in `tests/onboarding/engine.fixture.test.ts`.

---

## Part B: the guide's open questions (section 8)

### B1. How does a payment reach Voone?

**Question.** Staff entry, a QR scan at the till, or an integration with the centre's
management software? The paid-visit redemption rule depends on it.

**Approach implemented.** Staff entry first: it needs nothing from the centre and the existing
reception screen already does it. The data model deliberately does not assume it.

- `PaidVisit` records every payment or consumed prepaid session, with a `source`
  (`STAFF_ENTRY`, `QR_SCAN`, `INTEGRATION`). Only `STAFF_ENTRY` is accepted anywhere, and the
  HTTP schema gives the caller **no field** to claim another, so nothing can pretend to be a
  till scan.
- Redemption is **enforced by the backend, not by convention**: a reward can only be
  redeemed against a `PaidVisit` of the same member and centre, on the same Madrid calendar
  day, and the check reads rows the database holds.
- Visits hold amounts and counts, never what was bought. Treatment names are special-category
  data in this product, and a record that must be kept cannot also be erasable.

**Where.** `prisma/schema.prisma` (`PaidVisit`); `runtime/visit.service.ts`;
`runtime/rules.ts` (`checkRedemption`); `runtime/decisions.ts`;
`tests/onboarding/runtime.integration.test.ts`.

**To change.** To accept a till QR or an integration, allow the new `source` in the visit
schema and in `decisions.acceptedVisitSources`; the redemption rule is already source-blind.

### B2. Who chooses the item for a surprise reward?

**Question.** Does staff choose from the pool in the dashboard, or is it logged as free text?

**Approach implemented.** Staff pick from the pool at redemption and the choice is stored on
the reward. This is the stricter reading: free text can be added later, but a free-text history
cannot be turned into a pool selection afterwards. Redeeming a surprise without an item, or
with one outside its pool, is refused.

**Where.** `runtime/reward.service.ts`; `MemberReward.surpriseItem`.

### B3. When does tenure start?

**Question.** Pass download, or the first paid visit? The reference assumes sign-up.

**Approach implemented.** Sign-up (`Member.createdAt`). It is the only date held for every
member, and the other two would make a member's tier depend on something the centre cannot see
or verify. A tier needs **both** its progress threshold and its minimum tenure (Oro 12 months,
Platino 24, Diamante 36). A client who reaches the threshold early keeps earning rewards and
enters the tier the day tenure is met, with the progress already banked. Tenure is counted in
whole months by Madrid calendar date.

**Where.** `runtime/rules.ts` (`tenureMonths`, `resolveTier`); `runtime/program-tier.port.ts`.

**To change.** Replace what `PrismaProgramTierPort` passes as the tenure start date.

### B4. Is the "3 products per year" limit calendar-year or rolling?

**Approach implemented.** Calendar year in Madrid: it is the reading the guide's section 6
assumes, and a receptionist can apply it without a calculator. A rolling 12 months from tier
entry would need a per-member anniversary that does not exist yet. The allowance is counted
from recorded visits (`PaidVisit.discountedProducts`), resets at midnight on 1 January **in
Madrid, not UTC**, and is zero in tiers with no discount.

**Where.** `runtime/rules.ts` (`discountAllowance`, `discountWindowStart`);
`src/common/utils/zoned-month.ts` (`startOfYearIn`).

### B5. Is progress shared across a group of centres?

**Approach implemented.** No: progress and rewards are per centre. A `Member` row belongs to
exactly one clinic, so this is not a flag that could be flipped later; sharing progress would
mean a different identity model. It is a decision to make with a real multi-centre customer.

### B6. Is recalibration automatic or prompted?

**Approach implemented.** **Prompted, never automatic.** The programme is something members
are working towards, so changing it is an act the centre must choose. The check only answers
"is it worth asking": it offers a recalibration when the measured ticket or visit frequency
drifts more than 15% from what the programme was built on, and stays silent under 90 days of
data. Creating the new draft is an explicit request; members keep their progress and the new
thresholds apply from approval.

**Where.** `OnboardingService.recalibrationFor`; `runtime/rules.ts` (`recalibrationAdvice`);
`GET /admin/clinics/:id/onboarding/recalibration`.

### B7. What does "leave a rating" mean?

**Approach implemented.** A public review must never earn progress, a reward or any benefit,
and the product must not ask only satisfied clients (both are against Google's policy).
There is deliberately **no code path** for it: progress can only come from a `PaidVisit`, and
no source of one is a review. If a private satisfaction survey is ever rewarded it is a
different feature with its own source, and this question must be answered first.

---

## Part C: further decisions made while building

These were not asked of Sergio, but each is a product rule the guide left open.

| #   | Decision                                                                                                                                                                                                              | Reasoning                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Progress is stored in **whole euros, rounded per visit** (half away from zero).                                                                                                                                       | The ledger holds integers (a CHECK enforces it) and a 1.1 multiplier on 65 € gives 71.5. Rounding once per visit bounds the error at half a euro instead of compounding.                                                          |
| C2  | A double-points perk doubles the **next payment visit**; a prepaid-session in between does not spend it.                                                                                                              | A session's value was fixed when the package was bought. The perk is spent automatically; it cannot be redeemed by hand.                                                                                                          |
| C3  | The recurring reward after Diamante is first issued **one interval past** the Diamante threshold.                                                                                                                     | Starting at the threshold would hand a reward to everyone on the day they arrive, on top of entering the tier.                                                                                                                    |
| C4  | Tiers are never lost, except by an explicit staff **correction**.                                                                                                                                                     | The guide says tiers are not lost, but a mistaken credit must be undoable for tier as well as balance. `points:recompute` also demotes, because it derives the tier from ledger and tenure.                                       |
| C5  | Adding points **by hand is refused** at a clinic with a published programme (claw-back is not).                                                                                                                       | Only a recorded visit applies the multiplier, spends a double perk and issues rewards. A manual credit would leave progress and issued rewards disagreeing.                                                                       |
| C6  | `points:recompute` now asks the programme first.                                                                                                                                                                      | It ranked members on the legacy scale only, so running it would have reset every programme clinic's tiers.                                                                                                                        |
| C7  | `CatalogItem` is separate from `ClinicTreatment`.                                                                                                                                                                     | `ClinicTreatment` is deleted and recreated on every template save, minting new ids, and the engine's determinism depends on stable ids. **This duplication is temporary:** retire `ClinicTreatment` when the wizard is rewritten. |
| C8  | CSV import derives item ids from the **name** (`higiene-facial-detox`), not the row position.                                                                                                                         | A position-based id shifts when a row is inserted above it, changing every tie-break and so the ladder. Prices are stored in cents.                                                                                               |
| C9  | A referral counts only on the referred person's **first payment for a treatment** (retail-only does not count), is keyed by rank so a retry cannot double it, and cannot be attached to someone who has already paid. | The guide's rule, plus guards against farming: self-referral by id, phone or email is refused.                                                                                                                                    |
| C10 | A bad referral code at sign-up is **ignored silently**.                                                                                                                                                               | A typo must not cost someone their membership, and the response must not reveal which codes exist.                                                                                                                                |

---

## Part D: what is not built

Stated plainly, so nothing is assumed finished.

1. **The frontend, partly.** The admin wizard (catalogue, six questions, programme, swap,
   activate) and the staff visit and reward screens are built (Part E). Still open: the
   scan-to-credit screen is not adapted to programme centres, and the old wizard's hand-entered
   treatments step is kept for centres not yet on a programme (E10, E11).
2. **Birthday gifts.** The guide issues one on the member's birthday, but the system stores
   only a **birth year**. Issuing needs day and month, which is a data-collection and privacy
   decision. The gift is chosen and shown in the programme; it is never issued.
3. **Family & Friends.** Shown as a separate card in the programme presentation, but the
   centre-managed list of people and perks has no data model yet.
4. **Happy Hour.** The benefit is shown; flagging "fill fast" slots needs agenda integration
   that does not exist.
5. **Migrating existing members.** Publishing a programme does not retier existing members.
   They are ranked by it at their next movement, or when `npm run points:recompute --apply` is
   run. Their legacy tier names ("Gold") read as no tier until then. Run the script
   deliberately after publishing for a clinic that already has members.
   **Update 2026-10-29: first-programme conversion of legacy balances undecided: options 10 pts per
   euro / per-centre rate / leave.** Old points are typed per treatment with no fixed relation to
   euros, and ranking members from raw legacy ledger rows read as euros mis-ranks them, so the
   first publish still leaves existing members alone. `npm run programme:check-legacy` (read-only,
   counts only) shows what a centre has before it activates.
6. **Google Wallet.** The pass change is Apple/Google-agnostic (it feeds the shared card), but
   Google remains unconfigured for the pilot and was not exercised.
7. **Pushing and opening pull requests**, because of tooling gates on this machine, not code.

---

## Part E: the frontend

The screens are in the frontend repository (`Voone-frontend_service`): the admin wizard at
`/admin/clinics/:id/program`, and a visit and rewards panel on the member page. As in the
parts above, each entry gives the approach taken **while waiting for an answer**.

### E1. Who uses the wizard: Voone, or the centre itself?

**Question.** The guide describes the centre answering six questions. Does Voone's team run
this with the centre, or does the centre do it alone in its own dashboard?

**Approach implemented.** Voone's admin only, under the admin area. The programme screen also
shows Voone's own figures (what the rewards cost the centre, and whether each guarantee holds),
which the guide says a centre must never see. Those figures are hidden behind a toggle, off by
default, so a screen shared on a call never carries them.

**To change.** A centre-facing page would reuse the same components with the internal block
removed and the centre's own login; the backend already has a cost-free view for that.

### E2. How does a centre give us its price list?

**Question.** What do the centres actually have: a spreadsheet, an export from their agenda
software, or nothing? The guide says "upload the catalogue" and gives no format.

**Approach implemented.** Two ways, both saved automatically as the person types: paste or
upload a CSV (semicolon, comma or tab separated; name and price, with an optional third column
saying "producto" or a category), or add rows by hand. Rows the system cannot place in a
category stop the person from continuing until they pick one; nothing is guessed silently.
Importing replaces the whole catalogue, so it asks for a second click to confirm.

**To change.** If the partners have a standard export, a column mapping step replaces the fixed
column order.

### E3. Is the sixth question ("how many active clients") required?

**Question.** It changes nothing about the programme or the levels; it only sizes an internal
projection that has not been built. Should it still block the "see the programme" button?

**Approach implemented.** Yes, it must be answered, with no pre-selected value. The guide lists
six questions, and a silent default would store a made-up answer.

### E4. Ticket and frequency come pre-selected from the catalogue

**Question.** The first two questions are pre-filled from an estimate the engine makes from the
price list, and tagged "estimado". Is that what Sergio wants, or should they start empty?

**Approach implemented.** Pre-filled and tagged, because the guide says "use your own estimate"
is the common case; the centre can change either.

### E5. Does the programme update as answers change?

**Question.** Should the centre see the result live, or only after pressing a button?

**Approach implemented.** Live. A side panel recomputes (after half a second of no typing) from
a preview that is **not saved**. A draft is only created, and numbered, when the person presses
"Ver el programa completo". Every press creates a new draft version; older drafts are kept and
only the latest is shown. There is no clean-up of old drafts.

**To change.** If drafts should be limited or discarded, that is a small backend change.

### E6. Spanish wording

**Question.** The objective descriptions, the adaptation notes and every button were written
from the guide's examples. Can someone at the partner read them before a centre does?

**Approach implemented.** "Centro", never "clínica", throughout. The notes the engine adds
("como tu catálogo tiene pocos regalos posibles...") are the reference's own wording.

### E7. Costs stay out of anything a centre can see

**Approach implemented.** The programme a centre would read is built without any cost: the
screen cannot show one however it is edited. The staff screens (visits, rewards) have no
cost fields at all. This was checked down to the stored reward detail, which holds names and
values, not costs. No question; recorded so nobody removes the separation by accident.

### E8. Changing a reward

**Question.** The guide lets a reward be swapped for one of two alternatives that do not break
the ladder. Should that also be possible after a programme is active?

**Approach implemented.** Only on a draft. An active programme cannot be edited; to change it,
the person creates a new version and activates that. This keeps what members were promised
from changing under them.

### E9. Activating a programme

**Question.** Activating moves the centre from the old points scheme to the programme: manual
points stop working (C5) and existing members are not re-ranked until their next visit (D5).
Should activation warn about that, and be undoable?

**Approach implemented.** One click, then a message saying the programme is active. There is
**no confirmation dialog and no undo**. Activating a _new version_ only replaces the old one;
it cannot go back to the scheme before it. **Recommendation: add a confirmation that names
what changes, at least when the centre already has members.** Left out because it is a wording
decision for Sergio.

### E10. The old wizard step is kept

**Question.** The existing "create a centre" wizard still asks for treatments, tiers and
milestone rewards by hand. When should that step go?

**Approach implemented.** Left as it is. Centres not yet on a programme still depend on it for
their points, and removing it changes what the backend is sent when a centre is created. The
centre's page now has a "Loyalty program" card that leads to the new wizard. **Retire the old
step together with `ClinicTreatment` (C7)** once every centre has moved.

### E11. Staff: recording a visit and redeeming a reward

**Question.** This is B1 in practice: how a payment reaches Voone. The screens need an answer.

**Approach implemented.** On a member's page, at a centre with a programme, the "add points by
hand" form is replaced by a visit form: what was paid (by category, so retail and medicine can
be told apart), how many discounted products, or a prepaid session. The result shows the
progress earned, the new level and any rewards issued. Rewards are listed below it, with a
"Canjear" button that redeems **against the visit just recorded**; the visit is remembered for
the browser tab so a reload does not lose it. The system checks it is the same client, centre
and day.

**Not done.** The scan-to-credit screen still tries the old points route at a programme centre,
and shows the backend's refusal. Adapting it needs B1 answered (a scan at the till is one of
the options).

### E12. Browser translation breaks the screens

**Finding.** When Chrome auto-translates these Spanish pages into English, React could no longer
update them: a spinner next to a label crashed the page, and a "Borrador" badge stayed stale
after activation. Everything an English-speaking colleague might translate is now built so it
does not break (labels in their own element, status text re-created rather than edited).

**Question.** Should the admin and dashboard tell browsers not to translate at all
(`translate="no"`)? **Recommendation: yes.** The copy is deliberately Spanish and automatic
translation produced wrong words ("Importar" became "Matter"). Left off because it is a
product choice for anyone who wants an English view.

### E13. A security hole found on the way

**Finding.** The frontend's existing pass-through route (`/api/staff/[...path]`) forwarded any
path to the backend with Voone's staff key attached. Anyone signed in to **one** centre could
therefore reach another centre's admin endpoints. It now forwards only an allowlist of paths
(branch `fix/staff-proxy-allowlist`, separate from the wizard). The new admin and staff
handlers follow the same rule: the centre always comes from the login session, never from
anything the browser sends.

**Action needed.** That branch should be reviewed and deployed **independently and soon**; it
does not depend on this work.

---

## Part F: founders' feedback, round 1

Six changes to the centre-facing page, from the document `Voone_Onboarding_Feedback_Round1`
(13 Oct 2026). All six are built. Where the document left something open, or where building it
showed a problem, the approach taken while waiting for an answer is recorded here.

### F1. Exact ticket and visits

**Built.** Each of the first two questions keeps its chips as quick picks and has an exact
number beside them, pre-filled with the recommendation, tagged "Recomendado", with a link back
to it. The number is what the programme is built from, and changing it regenerates the whole
programme. Ranges are the document's: ticket 10 to 1,000 € (whole euros), visits 0.5 to 26 (one
decimal). Outside them the box shows the reason and the programme is **not** rebuilt. The
existing review note for figures more than three times the catalogue's annual spend is kept.
Choosing a chip clears a typed figure, and typing a figure clears the chip.

**Question.** None on the rule itself. One detail: if a centre types exactly the recommended
figure, it is stored as "no answer", so the engine keeps its unrounded estimate.

### F2. Replacing a live programme: what happens to members

**Built, with one correction found on the way.** After a programme is live, the same edit makes a
new draft that the centre must approve. On approval:

- Members keep their progress. It is stored in euros, so nothing is converted.
- Each member is placed on the new ladder by her progress, **moved up where it now earns a higher
  tier and never down.**
- A step she has already passed on the new ladder is not issued again.
- Rewards already issued stay valid until their own 60-day expiry, and can be redeemed under the
  new version.
- Every issued reward already records its programme (the version is its programme row).

**Correction.** Rewards were de-duplicated on "milestone number", but a new version puts a
different threshold at the same number. A member who had received the old milestone 7 would
silently never have received the new one. The key now includes the version. A test fails if the
version is removed.

**Question for Sergio.** "Placed on the new ladder by her current progress" can be read as
allowing a **demotion** when the new ladder is harder. The guide says tiers are not lost, so none
is made. Confirm that is wanted.

**Not done.** Passes (Apple and Google Wallet) of members promoted this way refresh at their next
visit, not at the moment of approval. Publishing the first programme a centre has ever had does
not place members at all (D5 still applies).

### F3. No gift value anywhere on the centre's page

**Built.** The backend no longer sends a value for any gift: ladder rows, alternatives, the
recurring reward and referral rows carry names only. A test fails if a `value`, `cost`, `budget`
or `price` key, or a "(45 €)" style text, ever appears in what a centre sees. Value stays in the
engine and the stored programme, where choosing rewards needs it. The internal toggle for Voone
does not show gift values either; it can if Voone wants them.

### F4. "La clienta ha gastado" on milestones

**Built.** The right-hand column is the real spend, not the progress threshold (they match up to
Oro and then diverge because progress counts ×1.1, ×1.2 and ×1.3). Diamante shows 1,500 € for
the Sapphira fixture, as the document says. The left shows only the month ("Mes 30"), taken as
real spend ÷ annual spend × 12, rounded. Tier cards and the band headers use real spend too.
Amounts are shown in whole euros.

**Decision.** The recurring reward after Diamante used to read "every 250 € of progress". It now
reads in euros actually paid (250 ÷ 1.3 ≈ 192 €), so no progress figure remains on the page. The
document does not mention it; change it back if the founders prefer progress there.

### F5. "Has generado como mínimo" on referrals

**Built.** Referral count × the programme's ticket (650 € at the tenth referral with 65 €). It
follows the ticket when the centre edits it.

### F6. Family & Friends: "Próximamente"

**Built.** The card stays, dimmed, with a "Próximamente" badge and nothing to press. No backend
work.

### F7. The five-year calculator

**Built.** Two inputs (clients in the programme, default half of question 6's answer; average
ticket, default the programme's own), a generates-versus-costs chart with the net line, members
by tier per year, a table, a collapsed "Cómo se calcula" and the footnote the document asks for.
Visits per year are not an input; they come from the programme. It never changes the programme.
All the founders' percentages are named values in `calculator.config.ts`.

**The reference code was not available.** The document points to `src/calculator.cjs` and
`fixtures/sapphira.calculator.expected.json` in the developer package, but neither is in the
package we were given. The model was written from the formulas in the document. It reproduces the
document's own Sapphira table **to the euro in every year** (members, members by tier, what it
generates, what it costs, the net), and a test checks it. Two details the document does not
spell out were fixed to match that table: occasional clients are charged a tier's benefits as
priced at the repeater's spend, scaled to 30%; and the referral cost uses the programme's overall
cost rate. **If the reference code exists, send it so the two can be compared on other
catalogues.**

**Deviation: it runs on the server.** The document says "client-side". The calculator needs what
every reward costs the centre, and sending that to the browser would put every gift's cost in
the page's data, which the guide forbids even if it were never shown. So the browser sends the
two figures and gets back yearly totals only, after a short pause in typing. The cost is a
network round trip per change instead of none. **Question:** is that acceptable, or is the
founders' wish for fully client-side worth sending costs to the browser?

**Fee.** The subscription uses Voone's monthly fee for the kind of centre (49.99, 99.99 or
149.99 €), as in the reference engine. Confirm those are still the prices.

### F8. Out of scope, as the document says

Happy Hour discounts and retained revenue from medical treatments are not modelled.

### F9. Browser translation, again

**Finding.** The live preview and the calculator are re-created for each new answer, because a
browser that auto-translates the page makes React's later edits invisible: the preview showed an
earlier answer's figures. The recommendation in E12 (tell browsers not to translate these
screens) still stands.

## Part G: founders' end-to-end test (19 October 2026)

Groups B, C, D and G of `Voone_E2E_Test_Feedback.pdf`. Where this contradicts the guide, the
feedback wins, as agreed.

### G1. Points are ten per euro, converted at the edge (B 48–50)

The engine keeps progress in euros: every threshold, tier and reward is a euro figure, and the
ledger stores it. Storing ×10 would mean rescaling every threshold, the reward-crossing logic and
every existing balance. Instead `POINTS_PER_EURO = 10` (`runtime/points-unit.ts`) converts when a
programme centre's figure leaves the system: the members list, the scan lookup, the pass, and the
visit outcome (`points`, `pointsTotal`). Centres without a programme are unchanged.

- **Overrides the guide.** The guide says the pass states the distance to the next reward in euros,
  "never points". The pass now says "te faltan N puntos" (B 50).
- **Money spent** (B 48) is the sum of the visits' amounts. That is the amount that earns progress,
  so a retail-only line that earns nothing is not counted as spent, and a voucher session counts
  its price divided by its sessions. **Question for Sergio:** should "spent" include retail that
  earns no points? It needs a new column to record the full amount paid.
- **0 % progress** (B 49): the pass is rebuilt on every credit, so the bar follows the visit. If a
  client still sees 0 % after a visit, check that the pass actually re-synced; refreshing a pass
  when a new programme version goes live is still not built.

### G2. Consent (C 1, 44)

A person who signs up through the QR form has to tick acceptance of the processing of their data;
the backend refuses a sign-up without it and stores when (`Member.privacyAcceptedAt`). Staff-entered
members are not asked. The centre's own consent at onboarding already blocked "Continue"; it now
links to the full document.

**The legal text is not engineering's to write.** `/privacidad` and `/legal/tratamiento-datos` are
placeholders, marked "texto provisional" on the page. **Request for Sergio:** the real privacy
notice and the centre's data-processing agreement, ideally as final text per language.

### G3. Tier benefits (G 27)

A centre can add and remove its own benefits per tier on a draft. They are text only. The
benefits the engine derives (multiplier, cosmetics discount, birthday gift, events, tests) stay
fixed, because each one has a runtime effect and an editable line could promise something the
system does not do. Up to 6 per tier, 80 characters each.

### G4. Questions and referral copy (G 24, 25, 29, 30)

- **Referral copy (G 29).** The feedback says the referred person gets ×1.5 points on her first
  treatment. (Superseded by the ×2 rule in G6, 2026-10-29.) The engine does something different: she starts with a **welcome amount already
  earned** (half the first milestone), and the referrer's reward is unlocked by her first paid
  treatment. The copy now states what the engine does. **Question for Sergio:** is ×1.5 the intended
  rule? If so it is a rule change, and the reference fixtures pin the current behaviour.
- **300 clients (G 30).** The calculator's default came from the sixth answer (150–400 gave 138).
  The sixth question now starts on "400 to 800", which gives 300.

### G5. Not done, and why

- **G 28, editable milestone rewards.** The swap exists and is wired for drafts, offering the two
  alternatives that keep the ladder's cost guarantees. "Choose any item from the catalogue" would
  let a centre break those guarantees. **Question for Sergio:** keep the two alternatives, or allow
  any item with a warning when the cost target is exceeded?
- **G 26, blank screen when scrolling.** Needs a reproduction in the browser; not diagnosed.
- **D 15, 16, 17, 19, 38, restructuring onboarding so the centre is created only at the end.** It
  reverses the round-2 removal of the programme step and needs an approach decision (see below).

### G6. Sergio's answers (round on the founders' E2E questions)

- **Milestone rewards (G 28): any catalogue item.** The centre can now give a milestone any item
  that may be a reward, not only the engine's two alternatives. The ladder must still climb, so a
  choice worth less than the previous reward is refused with the reason; a dearer one is allowed
  and flagged. This supersedes the "Question for Sergio" in G5.
- **Referral (G 29): keep the engine's rule.** The referred person starts with a welcome amount
  already earned; no ×1.5. The copy already says this.
  **Update 2026-10-29: this is reversed.** The product owner decided that a referred client earns
  ×2 on their FIRST payment visit, on top of the welcome credit (not ×1.5, and not instead of the
  welcome). The rules, as implemented (`runtime/double-points.ts`, the one place that decides):
  - "First payment visit" means the first PAYMENT visit that earns progress (earning cents > 0). A
    medicine-only basket, a prepaid-package session and a visit that earns nothing are not it, so
    the ×2 waits for the next real payment.
  - ×2 in total, never ×4: if a double-points perk is also waiting at that visit the visit is
    still ×2, the REFERRAL is what doubles it, and the perk is NOT consumed. The client keeps what
    they earned; the perk doubles their next payment.
  - Idempotent: a retried visit answers the same (`doubled: true`, `doubleReason: "referral"`) and
    is not a second "first visit". The ledger row reads "Visita de pago (doble por recomendación)".
  - A double-points perk is no longer spent by a visit that earns 0 progress (it stays waiting),
    and a retried perk-doubled visit answers `doubled: true, doubleReason: "perk"`.
  - Reception's manual ×2/×3/×5/×10 slider adds nothing while a ×2 applies. The backend cannot see
    the slider, so `GET /clinics/:slug/members/:memberId/rewards` also returns
    `doublePoints: { applies, reason: "perk" | "referral" | null, until: ISO | null }`, decided by
    the very code that credits the visit, and a visit request may carry `boostMultiplier`
    (2, 3, 5 or 10) to flag that its `bonusPoints` are the slider's extra: it is then ignored
    while a ×2 applies (the visit is not refused). A typed bonus without the flag still adds.
  - The client sees it: the wallet card carries `boost` ("PUNTOS DOBLES" back field on Apple, a
    `boost` text module on Google) and the member's own code and sign-up link (`referral`,
    "RECOMIENDA"; `<FRONTEND_URL>/alta/<slug>?ref=<code>`).
- **Legal text (C): Sergio does not know where to get it.** Needs a Spanish data-protection lawyer
  or the centres' gestoría; the pages stay marked provisional.
- **Money spent (B 48): products count.** They already do: retail earns progress like a
  treatment, so 60 € treatment + 40 € product = 100 € = 1000 points (a test pins it). Only
  pharmacological medicine and medical acts earn nothing, a legal constraint in Spain, so "money
  spent" excludes just those. G1's open question is closed and no new column is needed.
