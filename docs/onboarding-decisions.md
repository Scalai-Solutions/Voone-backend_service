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
