# Product Flaw Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the product flaws listed in the spec across the backend and frontend, delivered as six pull requests.

**Architecture:** Backend changes keep the existing module layout (`src/modules/<area>`, routes in `src/routes/v1`). The frontend is Next.js; its proxy routes under `src/app/api/staff` and `src/app/api/admin` forward to the backend with the staff key. Order matters: the frontend sends the clinic header before the backend enforces it.

**Tech Stack:** Node, Express, Prisma, Vitest (backend); Next.js 16, React Query, react-hook-form, zod (frontend).

**Spec:** `docs/superpowers/specs/2026-10-26-product-flaw-fixes-design.md`

**Spec correction:** the "Apple Wallet: Próximamente" badge seen locally was an unconfigured Apple provider on the local server (`member-directory.service.ts` returns `"unavailable"` when a provider is not configured), not a flaw. It is dropped.

## Global Constraints

- Backend: `npm run typecheck`, `npx eslint . --max-warnings=0`, `npx prettier --check .`, and `DATABASE_URL='postgresql://weekend@localhost:5432/voone?schema=public' npx vitest run` must all pass. Never run tests against a remote database.
- Frontend has no test runner. Its checks are `npm run typecheck`, `npm run lint`, and the manual check written in each task.
- Every backend task carries a test that fails without the change.
- Spanish for everything a clinic user or client sees; the Voone admin panel stays English.
- "Miembro" and "N.º de miembro" replace "socia" and "N.º de socia" (match `\bsocias?\b`, not substrings such as "asociado").
- Points shown to a client are `toPoints(progress)` (ten per euro) for programme centres.
- No change to Apple serial numbers or pass type; installed cards keep working.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01F8tkTdA1VBbR9eAY3F6EnK`. Do not push; give the user the push and `gh pr create` commands.

## Review Focus

- An owner sets a price of 0, a negative, or a huge number: refused with a Spanish message (Task 8).
- An owner deletes a treatment that past visits used: visit history keeps its recorded amounts (Task 8).
- A template saved by a clinic with no wallet passes: change record shows 0 cards, confirmation says none, no error (Tasks 2, 9).
- An admin opens clinic A's editor while the request carries clinic B's id: 404, nothing saved (Task 2).
- Google fails at clinic creation and later succeeds on a template save: the template moves from PENDING to ACTIVE (Task 5).

## Pull requests, in order

| PR  | Repo     | Branch                                        | Tasks |
| --- | -------- | --------------------------------------------- | ----- |
| 1   | frontend | `fix/send-clinic-header-on-template-reads`    | 1     |
| 2   | backend  | `fix/template-safety`                         | 2-6   |
| 3   | backend  | `fix/points-unit-and-spanish`                 | 7-9   |
| 4   | frontend | `fix/ui-consistency`                          | 10-12 |
| 5   | backend  | `feat/owner-treatments-api`                   | 13    |
| 6   | frontend | `feat/owner-treatments-and-card-confirmation` | 14-15 |

PR 2 deploys only after PR 1 is live. PR 6 deploys after PRs 3 and 5.

---

## PR 1 (frontend)

### Task 1: Template reads carry the clinic id, and writes carry who made them

**Files:**

- Modify: `src/lib/api-client.ts` (`getTemplate`, `getCurrentClinicTemplate`, `getTemplates`)
- Modify: `src/app/(dashboard)/dashboard/templates/[templateId]/page.tsx`, `src/app/(admin)/admin/clinics/[clinicId]/card/page.tsx`
- Modify: `src/lib/staff-api.ts` (`staffFetch` also sends `x-actor: <session user email>`, which the backend records in Task 2)

**Interfaces:**

- Produces: `getTemplate(templateId: string, clinicId: string): Promise<Template>` sending header `x-clinic-id: clinicId`; `getTemplates(clinicId: string)`.

- [ ] **Step 1:** Add the `clinicId` parameter and header to the three functions; update both pages (clinic id from `session.clinicId` and from `clinic.id`).
- [ ] **Step 2:** Run `npm run typecheck && npm run lint`. Expected: no new errors.
- [ ] **Step 3:** Manual check: open the card editor as owner and as admin; the form loads with data.
- [ ] **Step 4:** Commit `fix(templates): send the clinic id with template reads and the actor with writes`.

---

## PR 2 (backend): template safety

### Task 2: Ownership check and change record

**Files:**

- Modify: `src/modules/templates/templates.controller.ts` (`getById`, `list`, `update`), `src/modules/templates/templates.service.ts`
- Create: `src/modules/templates/template-change.service.ts`, migration `prisma/migrations/20261026090000_template_change/migration.sql`
- Modify: `prisma/schema.prisma` (model `TemplateChange`: `id`, `clinicId`, `templateId`, `changedBy String?`, `changedFields String[]`, `cardsAtSave Int`, `createdAt`)
- Test: `tests/templates/templates.ownership.test.ts`, `tests/templates/template-change.test.ts`

**Interfaces:**

- Produces: `assertOwnsTemplate(template: { clinicId: string } | null, clinicId: string): asserts template` (throws the existing not-found error, so a wrong clinic sees 404, never 403); `diffTemplate(before: TemplateFields, after: TemplateFields): string[]` over `programName, hexBackgroundColor, logoUrl, logoOnDarkUrl, heroImageUrl, websiteUrl, appointmentUrl, appLinkText, appLinkDescription, pointsLabel, tierLabel, benefitsText, infoText`; `recordTemplateChange(db, input: { clinicId; templateId; actor?: string; changedFields: string[]; cardsAtSave: number }): Promise<void>`.

- [ ] **Step 1: Write failing tests.** `ownership`: `getById` with another clinic's `x-clinic-id` returns 404; `update` with another clinic's id returns 404 and calls nothing; `list` returns only that clinic's template; matching clinic succeeds. `change`: saving a new `heroImageUrl` writes one record with `changedFields: ["heroImageUrl"]`, the `x-actor` value, and `cardsAtSave` equal to the count of members with a wallet pass; saving identical values writes none.
- [ ] **Step 2:** Run `npx vitest run tests/templates` and confirm the new tests fail.
- [ ] **Step 3:** Implement the interfaces above; `updateClinicTemplate` computes `cardsAtSave` with `prisma.member.count({ where: { clinicId, erasedAt: null, walletObjects: { some: {} } } })` and records inside its transaction.
- [ ] **Step 4:** Run the template tests; expect PASS. Run `npx prisma migrate deploy` against the local database.
- [ ] **Step 5:** Commit `feat(templates): enforce template ownership and record who changed a card design`.

### Task 3: Activation needs the clinic's own logo

**Files:** Modify `src/routes/v1/admin-clinics.route.ts` (activate handler, ~line 688), `src/config/env.ts` (`VOONE_DEFAULT_LOGO_URL` optional URL). Test: `tests/admin/activate-logo.test.ts`.

**Interfaces:** Produces `hasOwnLogo(template: { logoUrl: string | null }, defaultLogoUrl?: string): boolean` in `src/modules/templates/own-logo.ts`.

- [ ] **Step 1:** Test: activating a clinic whose template logo is null, empty, or equal to the default returns 409 with message `Añade el logo propio del centro antes de activarlo.`; with a different logo it activates.
- [ ] **Step 2-4:** Run to fail; implement `hasOwnLogo` and call it in the handler; run to pass.
- [ ] **Step 5:** Commit `feat(clinics): a clinic cannot be activated without its own logo`.

### Task 4: Remove the borrowed default images

**Files:** Modify `src/wallet/providers/google/google-wallet.provider.ts:181-182`, `src/routes/v1/wallet-test.route.ts`. Test: `tests/wallet/google-class-defaults.test.ts`.

- [ ] **Step 1:** Test: a template with no logo or hero builds a class whose `logoUrl` is `config.VOONE_DEFAULT_LOGO_URL` (or absent when unset) and whose `heroImageUrl` is absent; never an `i.ibb.co` URL.
- [ ] **Step 2-4:** Run to fail; replace the `DEFAULT_WALLET_*` fallbacks with the config value and no hero; run to pass.
- [ ] **Step 5:** Commit `fix(wallet): no borrowed client images as card defaults`.

### Task 5: A Google failure does not block clinic creation

**Files:** Modify `src/modules/clinics/clinic-provisioning.service.ts` (~lines 219-226). Test: extend `tests/clinics/clinic-provisioning.test.ts`.

**Interfaces:** The provisioning result gains `walletWarning?: "google_pending"`.

- [ ] **Step 1:** Tests: engine throwing `GoogleWalletApiError` yields a created clinic, template status `PENDING`, `walletWarning: "google_pending"`; any other error rolls back and returns a specific Spanish message; a later `updateClinicTemplate` that succeeds sets status `ACTIVE`.
- [ ] **Step 2-4:** Run to fail; catch only `GoogleWalletApiError` around `createClassForTemplate`, mark the template failed/pending, return the warning; run to pass.
- [ ] **Step 5:** Commit `fix(clinics): create the clinic when Google rejects the card, retry on next save`.

### Task 6: Flag clinics on a default logo

**Files:** Modify `src/routes/v1/admin-clinics.route.ts` (clinic list payload). Test: `tests/admin/clinic-list-flag.test.ts`.

- [ ] **Step 1:** Test: list payload has `usesDefaultLogo: true` for a template whose `logoUrl` is null, empty, or on the borrowed host list (`i.ibb.co` defaults copied from the old constants), false otherwise.
- [ ] **Step 2-4:** Run to fail; compute with `hasOwnLogo`; run to pass.
- [ ] **Step 5:** Commit `feat(admin): flag clinics that still use the default logo`.

---

## PR 3 (backend): points unit and Spanish

### Task 7: One "programme centre" helper

**Files:** Modify `src/modules/onboarding/runtime/points-unit.ts`, `src/modules/notifications/notification.service.ts`. Test: `tests/onboarding/points-unit.test.ts`.

**Interfaces:** Produces `isProgrammeCentre(prisma: PrismaClient, clinicId: string): Promise<boolean>` and `displayPoints(prisma, clinicId, progress: number): Promise<number>`; `processPointsCredit` uses `displayPoints` instead of its inline count.

- [ ] **Step 1:** Tests: `displayPoints` returns 1200 for progress 120 with an `ACTIVO` programme, 120 without; existing `points credit` tests still pass.
- [ ] **Step 2-4:** Run to fail; implement and replace the inline count; run to pass.
- [ ] **Step 5:** Commit `refactor(points): one helper decides how a balance is shown`.

### Task 8: Spanish client-facing text, "miembro", and stored defaults

**Files:** Modify `src/wallet/providers/apple/apple-pass.strings.ts` (`member`, `memberNo`, `memberCode`, English `MIEMBRO: "MEMBER"` etc.), `src/wallet/providers/google/google-wallet.provider.ts:185-186,220-236`, `src/wallet/providers/google/objectService.ts:309`, `src/modules/templates/default-voone-template.ts`, `src/routes/v1/wallet-test.route.ts`, `src/modules/notifications/notification.service.ts` (header `Puntos actualizados`, body `Tu saldo ahora es ${n}`), DEFAULT tier label constant to `Nivel`. Create migration `20261026091000_miembro_defaults/migration.sql` rewriting `benefitsText` and `infoText` only where equal to the old default text, and `tierLabel` only where equal to `Miembro Gold`. Tests: update `tests/wallet/*`, add `tests/templates/default-texts.test.ts`.

- [ ] **Step 1:** Update tests to the new strings (they fail first): card labels `MIEMBRO` and `N.º DE MIEMBRO`, Google labels `Nombre de miembro` / `N.º de miembro`, default Google link labels in Spanish (`Web`, `Reservar cita`, `Beneficios`, `Información`), notification text.
- [ ] **Step 2-4:** Run to fail; change the strings and write the migration; run to pass; `prisma migrate deploy` locally and check with `psql` that only default rows changed.
- [ ] **Step 5:** Commit `fix(wallet): Spanish, neutral wording for everything a client sees`.

### Task 9: Refresh status read

**Files:** Modify `src/modules/templates/templates.controller.ts`, `src/routes/v1/templates.route.ts`; create `src/modules/wallet-refresh/refresh-status.ts`. Test: `tests/wallet-refresh/refresh-status.test.ts`.

**Interfaces:** Produces `GET /templates/refresh-status` returning `{ eligible: number; lastChange: { at: string; by: string | null; cardsAtSave: number } | null; syncedSince: number; failedSince: number }` via `getRefreshStatus(clinicId: string): Promise<RefreshStatus>`. `eligible` is members with a wallet pass now; `syncedSince` counts wallet objects `SYNCED` with `lastSyncedAt >=` the last change; `failedSince` counts `FAILED`.

- [ ] **Step 1:** Tests: no change recorded gives `lastChange: null` and zero counts; after a recorded change, counts follow object status and time.
- [ ] **Step 2-4:** Run to fail; implement; run to pass.
- [ ] **Step 5:** Commit `feat(templates): a clinic can see whether a card refresh reached its cards`.

---

## PR 4 (frontend): consistency

### Task 10: Wording, labels, and navigation

**Files:** Modify `src/components/admin/onboarding-wizard.tsx` (`TOTAL_ONBOARDING_STEPS = steps.length`), `src/components/dashboard/template-form.tsx` (tab labels `Diseño`, `Vista previa`, `Tratamientos` stays until PR 6; heading "Diseño de la tarjeta"; default `tierLabel` `Nivel`), `src/components/dashboard/member-detail.tsx:207` (`Registro bloqueado` becomes `Movimiento permanente`), every `\bsocias?\b` match under `src/` (`signup-form.tsx`, `field.tsx`, `why-voone.tsx`, `settings/page.tsx`, `current-clinic.ts`, `role-permissions-manager.tsx`, `default-wallet-template.ts`), currency text in `center-view.tsx` (`Precio: 60 €`), the admin "Templates" nav label to `Design library`, and "plantilla" to "diseño de la tarjeta" in clinic-facing strings. Also remove the borrowed images: `src/lib/default-wallet-template.ts` `DEFAULT_WALLET_LOGO_URL` and `DEFAULT_WALLET_HERO_IMAGE_URL` (a client's `i.ibb.co` photos, pre-filled by `onboarding-wizard.tsx` and `template-studio.tsx`) are replaced by the plain Voone default logo served from `public/` and no hero; the wizard blocks "Save and continue" until a logo of the clinic's own is entered.

- [ ] **Step 1-2:** Make the edits; run `npm run typecheck && npm run lint`.
- [ ] **Step 3:** Manual check: wizard shows `Step 1 of 3`; member page, signup form and card editor show no "socia" or English; admin nav shows "Design library".
- [ ] **Step 4:** Commit `fix(ui): consistent Spanish, neutral wording and honest labels`.

### Task 11: One card preview that matches the real card

**Files:** Create `src/components/shared/wallet-card-preview.tsx`; modify `onboarding-wizard.tsx` (remove inline `WalletCardPreview`), `template-form.tsx` (use it).

**Interfaces:** Produces `WalletCardPreview({ clinicName, programName, color, logoUrl, heroImageUrl, memberName, memberNumber, level, points, nextRewardPoints }: Props)`, laid out like the iPhone card: logo and level in the header, hero with points, a row with name and number and distance and progress, then the QR block.

- [ ] **Step 1-2:** Build the component with sample data labelled as such; replace both previews; typecheck and lint.
- [ ] **Step 3:** Manual check: both previews match the iPhone card layout.
- [ ] **Step 4:** Commit `refactor(ui): one wallet card preview, matching the real card`.

### Task 12: Contrast check reads the typed hero URL

**Files:** Modify `template-form.tsx` (`checkHeroContrast`).

- [ ] **Step 1-2:** Replace the file input with a check that loads the typed `heroImageUrl` with `crossOrigin="anonymous"`; if the canvas is blocked, show `No se pudo comprobar este enlace`; typecheck and lint.
- [ ] **Step 3:** Manual check with a bright image URL (warning appears) and a blocked one (message appears).
- [ ] **Step 4:** Commit `fix(ui): check hero contrast from the typed URL`.

---

## PR 5 (backend): owner-managed treatments

### Task 13: Treatment management API

**Files:** Create `src/modules/treatments/treatment-catalogue.service.ts`, `src/routes/v1/treatments.route.ts` (registered in `src/routes/v1/index.ts`); modify `src/routes/v1/index.ts` `treatmentsFor` and `member-directory.service.ts` `withSpendingStats` to read through `listTreatments`. Test: `tests/treatments/treatment-catalogue.test.ts`.

**Interfaces:** Produces `GET/POST /clinics/:slug/treatments`, `PATCH/DELETE /clinics/:slug/treatments/:id` guarded by `requireStaff` (the frontend gates by `clinicEdit`); `TreatmentRow = { id: string; name: string; priceEuro: number; categoryId: string | null; points: number }`; `listTreatments(clinicId)`, `createTreatment(clinicId, { name; priceEuro; categoryId })`, `updateTreatment(clinicId, id, Partial<...>)`, `removeTreatment(clinicId, id)`. A programme centre writes `CatalogItem` (`priceCents = priceEuro * 100`, `needsReview: false`, category required from the existing engine categories); any other centre writes `ClinicTreatment`.

- [ ] **Step 1:** Tests: creating on a programme centre writes a `CatalogItem` and `treatmentsFor` returns it; a price of 0, negative, or above 100000 is rejected with a Spanish message; deleting a treatment leaves existing visit rows untouched; a non-programme centre writes `ClinicTreatment`; another clinic's id returns 404.
- [ ] **Step 2-4:** Run to fail; implement; run to pass.
- [ ] **Step 5:** Commit `feat(treatments): owners manage their treatments and prices`.

---

## PR 6 (frontend): owner treatments, card confirmation, rewards source

### Task 14: Editable treatments in My center

**Files:** Create `src/app/api/staff/treatments/route.ts`, `src/app/api/staff/treatments/[id]/route.ts` (permission `clinicEdit`, clinic from session); modify `center-view.tsx` (Treatments tab editable with add, rename, price, category, remove), `template-form.tsx` (remove the Treatments tab and the "Información del centro" tab), `api-client.ts`.

- [ ] **Step 1-2:** Build; typecheck and lint.
- [ ] **Step 3:** Manual check: as owner add a treatment, change a price; the scan screen shows it; the card editor has no treatments or centre-details tab.
- [ ] **Step 4:** Commit `feat(dashboard): owners manage treatments from My center`.

### Task 15: Card save confirmation, and one source for rewards and levels

**Files:** Modify `template-form.tsx` (confirmation dialog before save: "Se actualizarán N tarjetas", using `eligible` from `GET /templates/refresh-status`; show last change: who and when; after save show `syncedSince` of `cardsAtSave` as "actualizadas en el servidor"), `src/components/admin/onboarding-wizard.tsx` (remove tier and milestone inputs and their payload keys so schema defaults apply), `center-view.tsx` Rewards and Levels tabs (read the live programme from `/api/staff/program`; keep "contacta con Voone").

- [ ] **Step 1-2:** Build; typecheck and lint.
- [ ] **Step 3:** Manual check: saving a design shows the count and, after saving, the progress and last change; a new clinic created through the wizard has default tiers; the owner's Rewards and Levels tabs match the live programme.
- [ ] **Step 4:** Commit `feat(dashboard): confirm card changes and show where they stand; one source for rewards`.
