# change-requests

A centre's tickets to Voone for what the owner cannot edit directly (rewards, levels, the
service catalogue, bonos). The owner files a request and talks in a thread; Voone answers and
resolves it by hand. Nothing here applies a change, sends mail or keeps drafts: the service
takes a `ChangeRequestNotifier` (no-op by default, see `notifier.ts`) so mail can hook in.

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
