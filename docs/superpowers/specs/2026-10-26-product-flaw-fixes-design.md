# Product flaw fixes: design

Date: 2026-10-26. Applies to Voone-backend_service and Voone-frontend_service.

## Intent

A review of the product found flaws that can embarrass a clinic or cross data between clinics, and
UI contradictions that make the product feel unfinished. This design fixes all of them, in batches
that each end in a pull request. The owner of the decisions is Hritik (CTO).

## Decisions (the user's)

1. **Who controls what.** A clinic owner manages the treatment list and prices directly, without
   Voone. Rewards and levels shape the whole programme and its cost, so they change only by
   creating a new programme version, never by editing in place.
2. **No impact preview, no draft** when an owner changes treatments or prices. It applies on the
   next visit. Points already earned stay as they are.
3. **A clinic cannot go live without its own logo.** New clinics start from a plain Voone default
   card (Voone logo, neutral colour, no photo) until they add their own.
4. **Card design changes** show a confirmation of what changes and how many clients' cards will
   update, and are recorded with who changed what and when. No version history, no restore.
5. **Language.** Everything a clinic user or client sees is Spanish, with no English mixed in. The
   Voone admin panel stays English.
6. **Neutral wording.** "Miembro" and "N.º de miembro" replace "socia" and "N.º de socia"
   everywhere in Spanish, on the card and in the dashboard, so one term is used for one thing.

7. **Programme versions stay with Voone.** Owners see the live programme and are told to contact
   Voone to change rewards or levels. Voone creates the new version in the admin panel.
8. **Clinics already live with a borrowed or missing logo are flagged, not changed.** The admin
   panel marks them "uses the default logo". Nothing is replaced automatically, because that would
   change cards already on clients' phones.
9. **A Google failure does not block creating a clinic.** The clinic is created, the Google card is
   marked pending with a clear message, and it is retried the next time the template is saved.

## Goals

- No clinic can ship another client's logo or photo.
- No staff user can read or edit another clinic's template.
- A card design change is confirmed before it reaches phones, and is attributable afterwards.
- A balance or reward distance shown to a client is in the same unit (points, ten per euro) on every
  surface: Apple, Google, notification text, scan lookup, member lists.
- The owner can see whether a card refresh reached the clients' cards.
- Screens say true things: badges match the member's real pass status, labels are not misleading.

## Non-goals

- Version history or one-click restore of card designs.
- A draft or impact preview for treatment changes.
- English in the clinic dashboard.
- SMS self-service card recovery, Happy Hour, birthday gifts, Family & Friends.
- Rebuilding the Apple card layout again (done in earlier PRs).
- Moving off Railway or changing the Apple account.

## Anti-goals (a failure even if it technically works)

- A second place to edit the same thing. Each field has exactly one editor.
- A change that silently rewrites data an owner did not touch (the treatment-prices bug).
- A clinic activated with a default or borrowed logo.

## Batches and what each contains

**Batch 1, backend: safety and data.**
- Template read and update verify the template belongs to the clinic named in the `x-clinic-id`
  header. The list endpoint returns only that clinic's template. The admin screens pass the real
  clinic id of the template they open, so one rule covers owners and admins. The public branding
  path through `/clinics/:slug` is unchanged. The backend trusts the shared staff key and the
  header (it has no user or role), so this stops wrong-clinic access by id, not a caller who holds
  the key and lies about the header.
- A change record for card design saves: clinic, template, who, when, which fields changed, how
  many cards were queued. Written on every successful save.
- Activation (`POST /admin/clinics/:id/activate`) refuses a clinic whose template has no logo of
  its own, with a clear Spanish message. A new clinic's template is created with the plain Voone
  default, not with any client's images.
- Image URLs stay single-URL (already done).
- Clinic creation: a Google failure leaves the clinic created and the Google class pending, with a
  clear Spanish message to the admin; the next template save retries it. Other failures return a
  specific message, not "Internal server error", and leave no half-created clinic.
- The admin clinic list marks clinics whose template has no logo of its own or still uses a
  borrowed default image. Flag only; no data is changed.
- The plain Voone default logo is a public file hosted on the frontend domain; the backend takes
  its URL from configuration. The old borrowed default images are removed from the frontend
  (wizard, template studio) and from the Google provider's fallback.

**Batch 2, backend: unit consistency and refresh visibility.**
- Sweep every place a balance or distance reaches a client or staff and use `toPoints` for
  programme centres: notification bodies, emails, SMS, scan lookup, receipts, visit outcome.
  One helper decides "is this a programme centre", used by all of them.
- A refresh status read: for a clinic, how many cards were queued by the last design change, how
  many have updated since, how many failed. Derived from existing wallet object rows.
- Client-visible English in the backend becomes Spanish: notification bodies ("Points updated",
  "Your balance is now ...") and the Google card's default button and module labels ("Website",
  "Schedule Appointment", "Benefits", "Information").
- "Refresh reached the cards" means: rebuilt and synced on the server after the change time. The
  owner sees it as "actualizadas en el servidor", not as "received on the phone". The change record
  stores the count of members with a wallet pass at save time. The status read counts how many are
  synced since then and how many failed.
- The refresh stays in the API process for now. Moving it to a queue is a deployment decision, not
  part of this work.

**Batch 3, frontend: consistency.**
- Spanish for everything a clinic user sees; the admin panel stays English. The card editor that
  owners use (`template-form`) is Spanish for admins too, since it is the same screen. The clinic
  wizard is admin-only and stays English.
- The default level label becomes "Nivel", so it never contradicts the member's actual level
  (it was "Miembro Gold" on a Bronze member).
- The stored default benefits text says "socias"; it is rewritten to "miembros" only where it
  still equals the default. Text an owner has edited is left alone.
- "Miembro" and "N.º de miembro" on the card (backend strings) and in every dashboard screen.
- Wallet badges on the member page show the real state: added or not added, per wallet. No
  "Próximamente" for a wallet that works.
- Visit history: replace "Registro bloqueado" with wording that says the entry is permanent and
  cannot be edited.
- Wizard progress shows the real number of screens.
- One vocabulary: "tarjeta" for what the client holds, "diseño de la tarjeta" for the editor,
  "programa" for rewards and levels. "Plantilla", "builder" and "studio" disappear from clinic UI.
- The contrast check reads the hero image URL that is typed, not a separate file.
- The editor and wizard previews follow the real Apple card layout (member and number on one row,
  reward distance cell, QR block) with the clinic's own data.
- "Price: 60 euros" and similar read as Spanish ("Precio: 60 €").

**Batch 4, frontend and backend: owner-managed treatments and card changes.**
- Owners and managers (the existing `clinicEdit` permission) can edit treatments.
- My center, Treatments tab, becomes editable for owners and managers: add, rename, change price,
  remove. It is the only place treatments are edited. For a programme centre the editor writes the
  programme catalogue (`CatalogItem`), which is what the scan-to-credit screen reads, and keeps
  `ClinicTreatment` in step as today; for other centres it writes `ClinicTreatment`. A new
  treatment needs a category chosen from the existing ones, so it never sets `needsReview` and
  never blocks a programme version. A price change does not alter the live programme's stored
  catalogue snapshot. Member spending stats read the same source as the scan screen. The Treatments tab leaves the card editor.
- Saving the card design shows the confirmation (what changes, how many cards) and writes the
  change record from Batch 1.
- Admin can open the same editor for a clinic (done in an earlier PR).

**Batch 5, frontend and backend: rewards and levels have one source.**
- The clinic sign-up wizard stops asking for tiers and milestones. The programme builder is the
  only source, and My center's Rewards and Levels tabs read from the live programme.
- Those tabs say how to change them: contact Voone, who creates a new programme version.
- The wizard no longer writes tiers and milestones; the template columns keep their schema
  defaults, which the legacy readers (tier scale, base tier at join, card reward text before a
  programme is live) still use, so a member who signs up before the programme is live still works.

## Constraints

- Two repositories; backend batches merge and deploy before the frontend batches that depend on
  them. Railway builds have been unreliable; each batch must be shippable on its own.
- Every batch passes typecheck, lint, format and the full test suite, and carries a test that
  fails without the fix.
- Existing installed cards must keep working: no change to Apple serial numbers or pass type.

## Left to the builder

- Table and endpoint names, file layout, the exact Spanish wording where not given above.
- How "who" is passed to the backend for the change record, following the existing notification
  audit pattern.
- Test layout.

## Calls made by the builder-check (the user may override)

- Owners and managers share the treatment-editing gate (`clinicEdit`).
- Ownership rule: one header match for owner and admin screens; reads included.
- The editor writes the catalogue for programme centres and `ClinicTreatment` otherwise.
- New treatments need an existing category, so they never block a programme version.
- Stored default texts are rewritten to "miembro" only when still equal to the default.
- The wizard stops asking for tiers and milestones; schema defaults feed the legacy readers.
- "Refresh reached the cards" means rebuilt and synced on the server, shown honestly as such.
- The Voone default logo is hosted on the frontend domain.
- Client-visible English in the backend (notifications, Google default labels) is Spanish, in Batch 2.
