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

| `POST /admin/change-requests/:id/apply` | `{note?}` | `{request, applied, warnings}` |
| `POST /admin/change-requests/:id/draft` | `{}` | `{request, programId}` |
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

| type           | `targetRef`                                               | `proposed`                                                                                                                                                          |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REWARD         | `{milestone: int>=1}` optional                            | `{milestone?, text?<=120, itemId?<=64}` optional                                                                                                                    |
| LEVEL          | `{tier: string<=32}` optional                             | `{tier?, text?<=120}` optional                                                                                                                                      |
| SERVICE_EDIT   | `{treatmentId}` required                                  | required: `{treatmentId?, name?, priceEuro?, categoryId?}`, at least one change                                                                                     |
| SERVICE_ADD    | none                                                      | required: `{name, priceEuro, categoryId?}`                                                                                                                          |
| SERVICE_REMOVE | `{treatmentId}` required                                  | `{treatmentId?}` optional                                                                                                                                           |
| BONO           | `{bonoId}`, required for edit and remove, refused for add | optional; if given, by `action`: `add` `{name, priceEuro, totalSessions}`; `edit` `{bonoId?, name?, priceEuro?, totalSessions?}` at least one; `remove` `{bonoId?}` |
| OTHER          | none                                                      | none                                                                                                                                                                |

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
