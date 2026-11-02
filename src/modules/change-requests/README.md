# change-requests

A centre's tickets to Voone for what the owner cannot edit directly (rewards, levels, the
service catalogue, bonos). The owner files a request and talks in a thread; Voone answers and
resolves it by hand. The service takes a `ChangeRequestNotifier` (no-op by default, see `notifier.ts`); production wires
`EmailChangeRequestNotifier` (see Email below).

## Trust

Every route sits behind the staff key (`x-voone-staff-key`), like the other `/clinics/:slug`
and `/admin` routes. The backend cannot check a session, so the frontend sets:

- `x-actor`: the signed-in person's email. Required on writes (403 without it); reads need only
  the role, because the app sends `x-actor` on writes only.
- `x-actor-role`: case-insensitive. Clinic routes accept `owner` / `manager`; admin routes
  accept `voone_admin`. Anything else, or nothing, is 403.

The roles come from headers, so they are only as trustworthy as the staff key. Hence these routers
fail closed: with `NODE_ENV=production` and no `STAFF_API_KEY` configured, every request is a 503
(`STAFF_KEY_NOT_CONFIGURED`); outside production, with no key, they stay permissive so local
development needs none.

The clinic side takes the clinic from `:slug` (the app passes the session's clinic) and
resolves every ticket id inside it: another clinic's id is a 404. Bodies are strict: an
unknown key (`clinicId`, `status`, `createdByEmail`...) is a 422.

## Clinic routes

| Route                                              | Body / query                                   | Answer                             |
| -------------------------------------------------- | ---------------------------------------------- | ---------------------------------- |
| `POST /clinics/:slug/change-requests`              | `{type, title, reason, targetRef?, proposed?}` | 201 ticket                         |
| `GET /clinics/:slug/change-requests`               | `?status&limit(1-50, 20)&cursor`               | `{items, nextCursor}` newest first |
| `GET /clinics/:slug/change-requests/:id`           |                                                | ticket + `messages` (oldest first) |
| `POST /clinics/:slug/change-requests/:id/messages` | `{body}`                                       | 201 ticket + messages              |
| `POST /clinics/:slug/change-requests/:id/reopen`   | `{message?}`                                   | ticket + messages                  |
| `POST /clinics/:slug/change-requests/preview`      | `{type, targetRef?, proposed?}` (see Flag)     | the owner's blurred flag           |

A reply on a RESOLVED or REJECTED ticket reopens it (to OPEN) when it was closed 14 days ago
or less; beyond that, reply and reopen are 409. Reopening an open ticket is 409. At most 20
tickets per clinic may be OPEN or IN_PROGRESS (create and reopen are 409 beyond that).
The clinic never sees `programId`, mail bookkeeping or Voone staff emails; it gets
`reopenableUntil` (ISO, or null) instead.

## Admin routes

| Route                                          | Body / query                           | Answer                                                                                    |
| ---------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /admin/change-requests`                   | `?status&clinicId&type&q&limit&cursor` | `{items, nextCursor}`, each with `clinic {id,name,slug}`, `messageCount`, `lastMessageAt` |
| `GET /admin/clinics/:clinicId/change-requests` | same filters                           | same, one clinic (404 unknown clinic)                                                     |
| `GET /admin/change-requests/:id`               |                                        | ticket + `clinic` + `messages` + mail fields                                              |
| `PATCH /admin/change-requests/:id/status`      | `{status, resolutionNote?}`            | ticket + messages                                                                         |
| `POST /admin/change-requests/:id/messages`     | `{body}`                               | 201 ticket + messages (VOONE author)                                                      |

| `POST /admin/change-requests/:id/apply` | `{note?, categoryId?}` | `{request, applied, warnings}` |
| `POST /admin/change-requests/:id/draft` | `{}` | `{request, programId}` |
| `GET /admin/change-requests/:id/comparison` | | the exact flag (see Flag) |
| `POST /admin/clinics/:clinicId/onboarding/programs/:programId/resolve-tickets` | `{note}` (required) | `{resolved: string[]}` |

`q` is a case-insensitive text search on the title and the clinic's name.

Transitions: OPEN to IN_PROGRESS / RESOLVED / REJECTED; IN_PROGRESS to OPEN / RESOLVED /
REJECTED; RESOLVED and REJECTED to OPEN only. Anything else is 409. RESOLVED and REJECTED
need a non-empty `resolutionNote`; they stamp `resolvedAt` and `resolvedByEmail`. Every move
to OPEN (admin or clinic) clears the three resolution fields, so a second resolution starts a
fresh 14-day window. An admin reply never changes the status.

## `type`, `targetRef` and `proposed`

All objects are strict. Strings are stripped of control characters (the reason, messages and
note keep line breaks). An empty object is stored as nothing. An id repeated in `targetRef`
and `proposed` must agree. Treatment and bono fields reuse the real write schemas, so a later
"apply" maps one to one (price 0.01 to 100000, two decimals; points are derived from the
price and duration is not editable, so neither is accepted).

| type           | `targetRef`                                               | `proposed`                                                                                                                                                |
| -------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REWARD         | `{milestone: int>=1}` optional                            | `{milestone?, text?<=120, itemId?<=64}` optional                                                                                                          |
| LEVEL          | `{tier: string<=32}` optional                             | `{tier?, text?<=120}` optional                                                                                                                            |
| SERVICE_EDIT   | `{treatmentId}` required                                  | required: `{treatmentId?, name?, priceEuro?, categoryId?}`, at least one change                                                                           |
| SERVICE_ADD    | none                                                      | required: `{name, priceEuro, categoryId?}`                                                                                                                |
| SERVICE_REMOVE | `{treatmentId}` required                                  | `{treatmentId?}` optional                                                                                                                                 |
| BONO           | `{bonoId}`, required for edit and remove, refused for add | REQUIRED, by `action`: `add` `{name, priceEuro, totalSessions}`; `edit` `{bonoId?, name?, priceEuro?, totalSessions?}` at least one; `remove` `{bonoId?}` |
| OTHER          | none                                                      | none                                                                                                                                                      |

A ticket filed again by the same person with the same type, title and reason within 60 seconds is a
retry: the stored ticket is returned (201, same body) and nobody is notified twice.

Limits: `title` 1-120, `reason` 3-2000, message `body` 1-2000, `resolutionNote` up to 2000.
Errors are Spanish, as `{code, message}`; the first problem only.

## Email

`EmailChangeRequestNotifier` sends through `src/modules/mail/mailer.ts` (SendGrid over `fetch`,
`SENDGRID_API_KEY` / `SENDGRID_FROM_EMAIL`; links use `FRONTEND_URL`). Every interpolated value
is HTML-escaped. It is best-effort: the ticket is stored first, a failure never reaches the
request, and the ticket records the latest attempt as `emailSentAt` or `lastEmailError` (a short
name such as `SENDGRID_HTTP_401`, `NO_RECIPIENT`; never a response body or an address).

| Trigger                                                                                     | To                                                        | Language |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------- |
| new ticket                                                                                  | `VOONE_SUPPORT_EMAIL`, link `/admin/customer-care/<id>`   | English  |
| clinic reply (also when it reopens: one mail), clinic reopen                                | `VOONE_SUPPORT_EMAIL`                                     | English  |
| Voone reply                                                                                 | the clinic's OWNER users, link `/dashboard/requests/<id>` | Spanish  |
| Voone status change (en curso / resuelta / rechazada / reabierta, plus the resolution note) | the clinic's OWNER users                                  | Spanish  |

Owner recipients are all OWNER users of the clinic; with none, the clinic's `billingEmail`;
with neither, nothing is sent and `lastEmailError` is `NO_RECIPIENT`. `VOONE_SUPPORT_EMAIL`
(optional, e.g. `business@voone.ai`): unset skips the Voone-side mails and records
`VOONE_SUPPORT_EMAIL not set`.

## Apply (admin)

`POST /admin/change-requests/:id/apply` makes the change a SERVICE_ADD / SERVICE_EDIT /
SERVICE_REMOVE / BONO ticket asks for, through the same `treatment-catalogue` and `bono-plan`
services the owner used to call (same validation), with the admin as the resolver. The change
and the move to RESOLVED are one transaction, so a refused change leaves the ticket open and a
second apply is a 409. `resolutionNote` is the admin's `note` or `Applied: <summary>`;
`onStatusChanged` fires (the owner is emailed). Errors (English, 409): ticket already closed,
type not applicable (REWARD, LEVEL, OTHER), target treatment/bono no longer exists, proposed
values not valid for the catalogue.

`applied` is `{kind: "treatment"|"bono", action: "created"|"updated"|"removed"|"deleted"|"retired",
summary, treatment?, bonoPlan?}`; `warnings` is `string[]`.

### Catalogue drift warnings

With an ACTIVE programme, apply returns (and the admin detail shows as `catalogueImpact` on an
open SERVICE_* ticket; null for other types, closed tickets, bono tickets and clinics with no
active programme) English warnings, never blocking: the programme version ("The catalogue changed
since the active programme (v2) was built: consider recalibrating."; before applying the wording
is "Applying this will change the catalogue compared with the active programme (v2): ..."), and
for an edited or removed treatment each live reward that uses it ("Milestone 3 reward "Bio-Pen"
uses this treatment.", or "The recurring reward ..."). Rewards reference items by the catalogue
row's `externalId`, matched against the programme's `output.chosen[].o.items[].id` and `output.rec`.

## Drafts and resolving linked tickets (admin)

`POST /admin/change-requests/:id/draft` (REWARD and LEVEL tickets only, 409 otherwise or when the
ticket is closed): reuses the clinic's BORRADOR programme, else clones its ACTIVO one with
`OnboardingService.cloneDraft`; with neither it is a 409 ("no active programme and no draft").
It sets `programId` on the ticket and moves OPEN to IN_PROGRESS (firing `onStatusChanged`); it
never pre-applies the proposed reward, the admin edits the draft. Several tickets may link one
draft; a ticket links at most one.

`POST /admin/clinics/:clinicId/onboarding/programs/:programId/resolve-tickets` (after publishing):
resolves every OPEN / IN_PROGRESS ticket of that clinic linked to the programme, RESOLVED with the
admin as resolver and the given note, firing `onStatusChanged` for each. Only for an ACTIVO
programme (409 for a draft or superseded one, 404 for another clinic's), so the owners are told
only once the change is live.

## Flag: what a reward or price ticket would do to the plan

`change-flag.ts` (`whatIf`) simulates, on a copy, what the clinic's five-year cumulative net would be if a
REWARD ticket (a giftable `itemId` on a premio `milestone`) or a SERVICE_EDIT price edit of a service that is a
live reward were applied. It uses the engine's own swap and comparison, the clinic's ACTIVE programme and its
catalogue as it is today, and returns three series: `live`, `proposed` and the engine's `recommended`.
`change-flag-present.ts` turns that into the two audiences' answers; `change-flag.service.ts` finds the
programme and catalogue. A flag never blocks a ticket and never throws: any failure is `none` (an unexpected
error is also logged as `[change-flag]`).

Statuses: `ok`, `unpriced` (free-text reward: nothing to simulate), `none` (no active programme, item not in
the clinic's catalogue or not giftable, not a premio milestone, swap refused, service not a live reward, a
treatment of another clinic, a name-only edit, any other ticket type).

**Owner**: `POST /clinics/:slug/change-requests/preview`, body strict `{type: "REWARD"|"SERVICE_EDIT", targetRef?,
proposed?}` with the same shapes as a ticket (unknown key or other type is a 422, Spanish). Only `OWNER` /
`MANAGER` (403 otherwise, and a refused role does not spend the allowance); the clinic is the path's slug, a
SERVICE_EDIT `treatmentId` is resolved inside that clinic only. Answers 200 with exactly one of:

- `{status: "ok", signal: "good"|"costs-more"|"similar", vsCurrent: Cell[5], vsRecommended: Cell[5]|null, fiveYearEuros: number|null}`
  with `Cell = {year, mark: "up"|"same"|"down", euros: number|null, percent: number|null, over20: boolean}`
- `{status: "unpriced"}`
- `{status: "none"}` (never a reason: the reasons are internal)

Rounding (the frontend pins the same rules): per year `delta = proposedCumulative - baselineCumulative`;
`pct = delta / |baseline|` when `|baseline| >= 500`, else null; mark `same` when `|pct| < 2%` (without pct:
`|delta| < 100`), else up/down by sign, and a cell whose euros round to 0 is `same`; `euros = round(delta/100)*100`,
`percent = round(pct*100/5)*5`, `over20 = |pct| > 20%` (the screen then says "more than 20%" and ignores `percent`);
a `same` cell carries `euros: null, percent: null`; `signal` is year 5 against the live plan.

**Leak control**: the clinic's browser never gets a gift's cost or value, the exact euros of the comparison, or the
recommended plan's own figures: no `years`, `live`, `proposed`, `recommended`, `rewardValueEuro`, `reason` or
`itemName`, only marks, euros to the nearest 100 and percents to the nearest 5. The route test computes the admin
answer for the same inputs and asserts none of its numbers is in the owner's JSON.

**Rate limit**: 30 previews per minute per clinic slug (429 `RATE_LIMITED`, Spanish, with `Retry-After`), applied
without the staff skip because the staff key is on every call. It is an in-memory fixed window, per replica: with N
replicas the real cap is N times that, and a deploy resets it (same caveat as `rate-limit.ts`). A second cap of
200 previews per 24 hours is keyed on the resolved clinic id (the slug and the uuid share one bucket), checked after
the role and the clinic lookup, with the same 429 body.

**Residual risk**: the owner's cells are linear in a SERVICE_EDIT price, so a determined owner could in principle
reconstruct approximate gift costs by probing many prices. Mitigations: the rounding above, the simulated price
being quantized to the nearest 5 EUR (min 5) for the owner only (Voone's comparison keeps the exact price), and the
daily cap. Accepted as a known limit.

**Known limits of the model** (documented, accepted):

- A SERVICE_EDIT reprices only `chosen[]` and `rec`, not `refLad[0]` (the referral gift) or
  `gifts[tier].birthday`. An item that is also the referral or birthday gift is therefore understated, and an
  item that is ONLY a referral or birthday gift reads `none`.
- A SERVICE_EDIT whose `proposed` also carries `categoryId` or `name` is `none` (admin reason "Category and name
  changes are not modelled."; the owner gets a plain `none`).
- SERVICE_EDIT is measured against the live plan at the item's price today: the stored plan was costed at
  generation, so the baseline is re-priced at the current catalogue price and a no-op edit reads as exactly
  nothing, even after the catalogue drifted. The REWARD path has a milder version of the same drift: choosing the
  item a milestone already holds, after that item was repriced, is compared with the stored (older) cost.
- A programme with no stored `recommended` is compared with a plan rebuilt by today's engine (`reason` is set).
  The admin sees both rows and the reason; the owner only the live row (`vsRecommended: null`), because that plan
  was never offered to them.
- The admin's `reason` is always English: the swap's Spanish refusals are mapped to English at the what-if
  boundary (unknown ones become "This swap is not allowed for this programme.").

**Admin**: `GET /admin/change-requests/:id/comparison` (role `voone_admin`, 404 for a missing ticket, English) answers
the exact figures: `{status: "ok", inputs: {clients, ticket}, years: [{year, live, proposed, recommended|null,
vsLive: {year, euros, percent}, vsRecommended: {...}|null}] x5, reason: string|null}` (whole euros, percent to one
decimal; `reason` is set when the programme predates the stored recommended plan and the current engine replayed it),
or `{status: "unpriced", itemName: null}`, or `{status: "none", reason}`. For a REWARD ticket naming an `itemId` the
answer also has `itemName` (from the live catalogue, null when unknown) so the screen never shows a raw id.

## Behaviour notes

- **Resolution notes stay in the thread.** Closing a ticket (status move, apply, resolve-linked) writes
  the note as a VOONE message in the same transaction, so a reopen (which clears `resolvedAt`,
  `resolvedByEmail` and `resolutionNote` from the ticket) never loses it.
- **The cap holds under concurrency.** Create, the clinic's reopen / reply-that-reopens and an admin
  move of a closed ticket to OPEN all take one advisory lock per clinic and count inside the same
  transaction (409 `CHANGE_REQUEST_LIMIT_REACHED`; Spanish for the clinic, English for admin).
- **Apply once.** `appliedAt` / `appliedByEmail` are set inside the apply transaction and never
  cleared; a second apply, even after a reopen, is a 409 `CHANGE_REQUEST_ALREADY_APPLIED` (a reopened
  applied ticket can still be resolved or rejected by hand). Both fields are admin-only (list, detail,
  apply response), never in owner responses.
- **Apply needs a category sometimes.** At a centre whose treatments live in the catalogue, a
  SERVICE_ADD with no `proposed.categoryId` cannot be applied as is: the admin detail says
  `needsCategory: true` and apply takes `categoryId` (an engine category id, from
  `GET /clinics/:slug/treatment-categories`, `[{id, label}]`). The owner's own category wins over the
  override; `categoryId` on any other ticket type is a 422.
- **`catalogueImpact` is read before the apply transaction** and a failure there only drops the
  warnings: it can never abort the apply.
- **Notifications are fire-and-forget.** They start after the commit and never delay or fail the
  request; resolve-linked sends its mails in turn in the background. SendGrid calls time out after 5
  seconds (`SENDGRID_TIMEOUT`). `ChangeRequestServiceOptions.background` lets a test await them.
- **Mail bookkeeping** (`emailSentAt`, `lastEmailError`) is written with raw SQL so it does not move
  `updatedAt` (which owners see). `lastEmailError` stays until a later mail of the SAME kind (Voone-side
  or clinic-side) succeeds, so a success to the clinic does not hide a failure to Voone.
- **Language.** Owner routes answer in Spanish, admin routes (errors, validation, forbidden, not
  found) in English.
