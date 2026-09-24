# The points ledger: append-only, and deliberately free of treatment data

## Why this exists now

VOO-20 is marked blocked on VOO-4 (the points scale) and VOO-5 (the Art. 9 legal basis for
treatment data). It gates ten tickets across Sprints 2 to 4 — VOO-21 credit/redeem,
VOO-22 tiers, VOO-23 milestones, VOO-24 the assembler swap, and every Scan and Metrics
task behind them. It is the single largest risk to the 18 October pilot.

This document argues that **neither dependency actually blocks the schema**, provided one
design constraint is accepted. If it is, VOO-20 can start immediately and VOO-4 becomes a
data-entry task rather than a gate.

Nothing here is implemented. It is a proposal for Hritik, Pablo and Pedro to accept,
reject or amend.

## The state today

```prisma
model Member {
  pointsBalance Int     @default(0)
  tier          String?
}
```

One integer and a nullable string. Every card issued so far reports zero points, because
nothing writes to either field — there is no ledger, so there is nothing to write.

Three problems with the current shape, independent of any decision still outstanding:

1. **One `Int` cannot carry both balances.** Spending points must reduce what a member can
   spend without reducing the lifetime total that earned them their tier. A member who
   redeems a reward does not drop from Gold to Silver. With a single counter, they do.
2. **A balance is not auditable.** "Why do I have 340 points?" has no answer. Neither does
   "who gave this member 5,000 points?" — which matters, because staff will be able to
   adjust points by hand (VOO-65).
3. **A balance cannot be recomputed.** Any bug in crediting is permanent: there is no
   record to replay.

## The constraint that unblocks VOO-5

**An append-only ledger and the right to erasure are in direct conflict, and the conflict
is unavoidable if special-category data goes into the ledger.**

VOO-5 asks whether crediting by named treatment makes this health data under Art. 9.
Suppose the answer is yes, and suppose treatment names live on ledger rows. Then:

- Art. 17 gives the member a right to erasure.
- The ledger's defining invariant is that rows are never updated or deleted.
- Satisfying the erasure request means breaking the invariant, on exactly the rows whose
  integrity matters most.

The usual escapes are all bad. Crypto-shredding a column means the ledger can no longer be
replayed. Tombstoning leaves the data present. Deleting the row destroys the audit trail
and every balance derived from it.

So the constraint is:

> **The ledger stores points movements and an opaque reason. It never stores a treatment
> name, a diagnosis, or anything else that could be special-category data.**

This is worth adopting _whatever VOO-5 concludes_, because it is the only version where
the ledger's core property survives contact with GDPR. And it has a useful consequence:

**VOO-5's answer stops blocking VOO-20.** If treatments may be recorded, they are recorded
in a separate, mutable, erasable table that the ledger references by id and does not depend
on. If they may not, that table simply does not exist. The ledger is identical either way.

What VOO-5 still governs is whether the _clinic-facing_ feature exists at all — which is
VOO-65's problem, not this one.

## How VOO-4 stops blocking it too

VOO-4 defines five tiers, ten milestones and a referral percentage. Those are **values**.
The schema needs to know that tiers exist and are driven by lifetime points; it does not
need to know that Gold starts at 2,000.

Put the thresholds in a table, seeded when VOO-4 lands. The tier engine is then written and
tested against arbitrary thresholds now, and given the real ones later. If VOO-4 slips, the
engine is still finished; only the seed is missing.

**The one thing VOO-4 must confirm before the schema is final** is that tier is driven by
_lifetime points earned_, not by spend in a rolling window. Those are different columns and
different indexes. The working assumption recorded on VOO-20 is lifetime, and everything
below assumes it. If Pablo and Sergio want rolling-window tiers, this design changes and
the estimate roughly doubles.

## Proposed shape

### `PointsTransaction` — append-only

| column           | notes                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| `id`             | uuid                                                                   |
| `memberId`       | indexed with `createdAt` — every read is "this member, in order"       |
| `clinicId`       | denormalised, so a clinic's whole ledger is one index scan for metrics |
| `points`         | signed `Int`. Positive earns, negative spends. One column, not two     |
| `kind`           | enum: `EARN`, `REDEEM`, `ADJUSTMENT`, `REFERRAL`, `EXPIRY`             |
| `reason`         | short free text, staff-authored, for `ADJUSTMENT`. Never a treatment   |
| `sourceRef`      | opaque id into whatever caused it. Nullable                            |
| `idempotencyKey` | unique. The double-redemption guard (VOO-21)                           |
| `createdAt`      |                                                                        |
| `createdBy`      | staff user id, nullable for system-generated rows                      |

No `updatedAt`. No soft-delete column. The absence is the point.

### The two balances

- **Spendable** = `SUM(points)`.
- **Lifetime** = `SUM(points) WHERE kind IN ('EARN', 'REFERRAL', 'ADJUSTMENT')`.

> **Corrected during implementation.** This originally read
> `SUM(points) WHERE points > 0`, which is wrong in a way that only shows up on a
> mistake: a staff member credits a million points by accident, a `-1,000,000`
> `ADJUSTMENT` corrects the spendable balance, and the member stays at the top tier
> for ever, because a negative row never reduced a sum of positive rows. Filtering by
> kind instead of by sign makes a clawback undo the tier as well as the balance.
> `REDEEM` and `EXPIRY` stay out: spending a reward must never demote anyone, and
> lapsed points were still earned.

Both derivable, which is the property worth having: a crediting bug is fixed by correcting
the rows and recomputing, not by hand-patching a counter.

`Member.pointsBalance` and `Member.tier` **stay**, as a cache. Reading a wallet pass must
not sum a member's whole history, and the sync fan-out reads these on every update. They
become derived values maintained by the credit service, with a recompute job as the
reconciliation path. The ledger is the source of truth; the columns are an index.

### Erasure

Erasing a member anonymises `Member` and leaves the ledger rows, which by construction hold
no personal data beyond a member id that now points at an anonymised row. Clinic-level
metrics stay correct, which is the behaviour a clinic expects and GDPR permits, because
nothing identifying survives.

## What I recommend

Accept the constraint, start VOO-20 now against this shape, and treat VOO-4 as a seeding
task rather than a gate. The only genuine blocker left is the one question above: **is tier
driven by lifetime points, or by spend in a rolling window?** That is a two-minute answer
from Pablo, and it is the only thing standing between this and a week of unblocked work.

## Deliberately not decided here

- Point expiry. `EXPIRY` exists in the enum so adding it later is not a migration of every
  row, but no expiry policy is proposed and none should be assumed.
- Whether tiers are global or per-clinic. The threshold table can carry a nullable
  `clinicId` and answer both, but the MVP should pick one and it is a product question.
- Referral mechanics (VOO-84/85, Post-MVP). `REFERRAL` is in the enum for the same reason
  as `EXPIRY`.
