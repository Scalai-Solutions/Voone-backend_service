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
- Template read and update verify the template belongs to the clinic named in the request. The
  admin route is the only exception and is checked by role.
- A change record for card design saves: clinic, template, who, when, which fields changed, how
  many cards were queued. Written on every successful save.
- Activation (`POST /admin/clinics/:id/activate`) refuses a clinic whose template has no logo of
  its own, with a clear Spanish message. A new clinic's template is created with the plain Voone
  default, not with any client's images.
- Image URLs stay single-URL (already done).

**Batch 2, backend: unit consistency and refresh visibility.**
- Sweep every place a balance or distance reaches a client or staff and use `toPoints` for
  programme centres: notification bodies, emails, SMS, scan lookup, receipts, visit outcome.
  One helper decides "is this a programme centre", used by all of them.
- A refresh status read: for a clinic, how many cards were queued by the last design change, how
  many have updated since, how many failed. Derived from existing wallet object rows.
- The refresh stays in the API process for now. Moving it to a queue is a deployment decision, not
  part of this work.

**Batch 3, frontend: consistency.**
- Spanish for everything a clinic user sees; the admin panel stays English. The card editor and the
  clinic wizard parts shown to clinics are translated.
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
- My center, Treatments tab, becomes editable for owners and managers: add, rename, change price,
  remove. It is the only place treatments are edited. The Treatments tab leaves the card editor.
- Saving the card design shows the confirmation (what changes, how many cards) and writes the
  change record from Batch 1.
- Admin can open the same editor for a clinic (done in an earlier PR).

**Batch 5, frontend and backend: rewards and levels have one source.**
- The clinic sign-up wizard stops asking for tiers and milestones. The programme builder is the
  only source, and My center's Rewards and Levels tabs read from the live programme.
- Those tabs say how to change them: creating a new programme version.

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
