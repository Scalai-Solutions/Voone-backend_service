# Membership sign-up: schema reconciliation + frontend integration

## Context

`feat/membership-signup` built a public, clinic-branded name + phone sign-up API against a
schema it invented, because on 11 September `prisma/schema.prisma` held exactly one model
(`Health`). That assumption is now void.

Satyam has pushed `main` (`b17789e`), which merges his `4e7cc7d template api` — branched from
the *original* `2a1e7eb`, not from the foundation commit — with the error/test foundation. It
carries `20260915000000_clinic_onboarding_templates`: eight models, the Google Wallet client,
and a templates API. **It is already applied to Supabase and the frontend builds on it, so it
is authoritative.**

Separately, `Voone-frontend_service` went from an empty repository to a ~13k-line Next 16 app
in three commits: admin area, clinic dashboard, wallet template editor, a working QR *scanner*,
and next-auth. It already has `react-hook-form`, `zod`, `@hookform/resolvers` and TanStack
Query installed.

The two schemas define the same two tables incompatibly, so this is not a merge git can
resolve:

| | `feat/membership-signup` | `main` (authoritative) |
|---|---|---|
| ids | `cuid()` | `uuid()` |
| `Clinic` | slug, tagline, privacyPolicyVersion, isActive | name, addressLine, pincode — **no slug** |
| `Member` name | `fullName` | `name` |
| `Member.phone` | required, E.164 CHECK, unique per clinic | **nullable, unconstrained, not unique** |
| `Member.tier` | `MemberTier` enum, default `BRONZE` | `String?` |
| points | *none* | `pointsBalance Int @default(0)` |
| consent | 4 columns | *none* |

**Outcome:** the sign-up feature folds onto `main`'s tables without losing idempotency or the
consent record, and a client at a clinic's reception desk can scan a real QR code, land on a
page branded with that clinic's own `ClinicTemplate`, and become a member.

### Verified state, not assumed

- Merging `feat/membership-signup` into `main` conflicts in exactly **three** files —
  `prisma/schema.prisma`, `prisma/seed.ts`, `src/routes/v1/index.ts`. All 31 other files
  (every service, middleware, route and test) apply cleanly.
- `main` is healthy: lint, typecheck and 6 tests pass. The typecheck errors on a fresh
  checkout are only a stale Prisma client — `npx prisma generate` clears them. vitest is now
  `5.0.1` (the "version mismatch").
- The foundation survived his conflict resolution intact: `app-error.ts`, its test, the fixed
  `errorHandler`, `vitest.config.mts`, `tsconfig.test.json` and the CI Test step are all present.
- `voone-web` has **no git remote** and a dirty tree (a `railway` dependency plus three
  four-line edits). It cannot be pulled and is not part of this work.

---

## Decisions taken

1. **ALTER `main`'s tables, keeping the full column set.** Not a parallel `Member`.
2. **Add `Clinic.slug`** — the QR URL stays readable (`/alta/aurea`).
3. **The frontend moves to `/api/v1`**, not the backend to `/v1`.
4. **All four frontend workstreams** are in scope: public route, the api-client
   silent-failure fix, the staff form rewire, and real QR generation.

---

## Part 1 — Backend reconciliation

This is the critical path; nothing frontend-side is real until it lands.

### 1.1 The migration must be re-dated

`20260911131920_add_clinic_and_member/` is dated **before** `20260915000000_...`, which is
already applied to Supabase. Prisma applies migrations in timestamp order and would see an
unapplied earlier migration, which is drift, not a no-op. So:

- **Delete** `prisma/migrations/20260911131920_add_clinic_and_member/` entirely.
- Create `prisma/migrations/20260916xxxxxx_membership_signup/` containing only `ALTER`s.

### 1.2 Schema changes (`prisma/schema.prisma`)

Keep every model `main` defines. Delete the `MemberTier` enum — `tier` is `String?` upstream,
and the wallet DTO on `feat/apple-wallet-pkpass-signing` already expects an optional free-text
tier. Then:

```prisma
model Clinic {
  // ... main's fields unchanged ...
  /// The URL key printed on a QR poster. Lowercase: Postgres unique is case-sensitive and a
  /// slug gets typed by hand off a poster.
  slug                 String  @unique
  /// Which notice a member was shown at sign-up. Per clinic because the clinic is the
  /// data controller, not Voone.
  privacyPolicyVersion String  @default("v1")
  /// A churned clinic's poster stays in its waiting room for months. Inactive clinics 404.
  isActive             Boolean @default(true)
}

model Member {
  // ... main's fields unchanged (name, phone String?, email, pointsBalance, tier String?) ...
  phoneRaw           String?
  normalizerVersion  Int      @default(1)
  phoneRegionAssumed Boolean  @default(false)
  memberSince        Int?     // Europe/Madrid year, frozen at signup. Nullable: main's rows have none.
  locale             String   @default("es-ES")
  consentMarketing   Boolean  @default(false)
  consentMarketingAt DateTime?
  privacyPolicyVersion String?
  consentSource      String   @default("staff_entry")
  signupCount        Int      @default(1)
  lastSignupAt       DateTime @default(now())
  erasedAt           DateTime?

  @@unique([clinicId, phone])
}
```

Three points where this differs from the original design, and why:

- **`phone` stays nullable.** `main`'s dashboard supports adding a member by email alone.
  Postgres treats NULLs as distinct in a unique index, so `@@unique([clinicId, phone])` gives
  exactly the wanted behaviour for free: one row per real phone number, and any number of
  email-only members. No partial index — which matters, because Prisma cannot express
  `WHERE phone IS NOT NULL` in schema. Verified directly against Postgres 15: two NULL-phone
  rows for one clinic both insert, and a duplicate real phone is rejected.
- **`memberSince` and `privacyPolicyVersion` on Member are nullable.** `main` already has rows;
  a required column with no default cannot be added to a populated table, and backfilling a
  consent version nobody was actually shown would manufacture false evidence.
- **`consentMarketing` gains a default and `consentSource` defaults to `staff_entry`.** Existing
  rows were created by staff, not through a consent flow. The public form always sends an
  explicit value, so the default never applies to a real sign-up.

### 1.3 Migration SQL — two hazards that need checking against live data first

```sql
-- 1. slug: nullable, backfilled, then constrained. A required unique column cannot be
--    added directly to a populated table.
ALTER TABLE "Clinic" ADD COLUMN "slug" TEXT;
UPDATE "Clinic" SET "slug" = 'clinic-' || substr("id"::text, 1, 8) WHERE "slug" IS NULL;
ALTER TABLE "Clinic" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX "Clinic_slug_key" ON "Clinic"("slug");

-- 2. The phone format constraint, NOT VALID. Existing rows came from a form whose only
--    rule was "at least 5 characters", so validating them would fail the migration. This
--    enforces the shape on every insert and update from now on and leaves history alone.
ALTER TABLE "Member"
  ADD CONSTRAINT "Member_phone_e164_es"
  CHECK ("phone" IS NULL OR "phone" ~ '^\+34[67][0-9]{8}$' OR "phone" LIKE 'erased:%')
  NOT VALID;
```

**Run both of these against Supabase before writing the migration** — either will abort it:

```sql
-- Duplicate (clinicId, phone) rows would make the unique index impossible.
SELECT "clinicId", "phone", count(*) FROM "Member"
 WHERE "phone" IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;

-- Rows that would fail the CHECK, i.e. how much the backfill owes.
SELECT count(*) FROM "Member"
 WHERE "phone" IS NOT NULL AND "phone" !~ '^\+34[67][0-9]{8}$';
```

If duplicates exist they must be resolved by hand — there is no correct automatic answer to
"which of these two people owns this number". Normalizing the non-conforming rows through
`normalizeSpanishMobile` and then `VALIDATE CONSTRAINT` is a follow-up task, not this one.

### 1.4 Code changes

| File | Change |
|---|---|
| `src/modules/members/membership.schema.ts` | Output `name`, not `fullName`. Everything else unchanged. |
| `src/modules/members/membership.service.ts` | `name:`, drop the `tier` default, set `consentSource: "qr_signup"`, `privacyPolicyVersion` from the clinic. |
| `src/modules/clinics/clinic.service.ts` | `findClinicBySlug` includes `template`; `toPublicClinic` projects the template's branding. |
| `src/routes/v1/index.ts` | Merge: `health`, `templates`, `walletTest` (dev-only), plus `clinics` and `members`. |
| `prisma/seed.ts` | Merge: his three `TemplatePreset` rows **and** two demo clinics, each with `addressLine`, `pincode`, `slug`, and a `ClinicTemplate` so the public form has branding to render. |
| tests | `fullName` → `name`; integration fixtures create `Clinic` + preset + `ClinicTemplate`. |

`member-name.ts`, `phone-es.ts`, `member-since.ts`, the middleware and the error classes need
**no change** — they never referenced the schema.

### 1.5 The contract

`GET /api/v1/clinics/:slug` — branding comes from `ClinicTemplate`, which already holds
everything the form needs. The invented `Clinic.tagline` is dropped.

```json
{ "clinic": { "slug": "aurea", "name": "AURÉA", "privacyPolicyVersion": "v1",
  "template": { "programName": "AURÉA Clinic Club", "hexBackgroundColor": "#ead0bd",
    "logoUrl": null, "heroImageUrl": null, "pointsLabel": "Puntos",
    "tierLabel": "Nivel", "benefitsText": "...", "infoText": "..." } } }
```

404 when the slug is malformed, unseeded, or the clinic is inactive. A clinic with **no**
template also 404s: there is nothing to brand the page with, and an unbranded page is worse
than an honest failure. A `PENDING` template still renders — status tracks wallet
provisioning, not whether the clinic may take sign-ups.

`POST /api/v1/clinics/:slug/members` — body becomes `{ name, phone, consentMarketing }`.
Response stays `200 {"status":"ok"}`, byte-identical whether created or already a member,
for the reasons in the previous design.

---

## Part 2 — Frontend integration (`Voone-frontend_service`)

`npm install` is step zero; `node_modules` is not installed in this checkout.

### 2.1 Fix the silent-failure trap first

`src/lib/api-client.ts:186-192` wraps every call in `withMockFallback`, which catches **all**
errors — including its own `"NEXT_PUBLIC_VOONE_API_URL is not configured"` throw — and returns
hardcoded mock data. No `.env` exists, so the app currently runs entirely on mocks with no
visible error.

Shipped as-is, a clinic's first real sign-up would **appear to succeed and silently persist
nothing**. So:

- Add `apiMutate<T>()` alongside `apiFetch`, with **no** fallback: it throws, and the form
  renders the failure.
- Leave `withMockFallback` on the dashboard reads, which are still mock-backed by design.
- Add `.env.example` — the repo has no documented env var list at all:
  `NEXT_PUBLIC_VOONE_API_URL="http://localhost:4000/api/v1"`.
- Because the base URL now includes `/api/v1`, the 14 existing paths must lose their `/v1`
  prefix or they resolve to `/api/v1/v1/...`. Map the two that have real backends
  (`/v1/wallet/templates` → `/templates/current`, `/templates/:id`) and strip the prefix from
  the rest; they 404 into their mocks exactly as they do today.

### 2.2 The public route

```
src/app/alta/[clinic]/page.tsx        NEW  server component: fetch clinic + template, notFound() on 404
src/app/alta/[clinic]/signup-form.tsx NEW  client component: the form
src/lib/phone-es.ts                   NEW  port of the backend normalizer, for inline validation
src/lib/api-client.ts                 EDIT getPublicClinic, signUpMember, apiMutate
src/components/ui/field.tsx           NEW  extract the Field helper, currently copy-pasted 4×
```

Next 16 specifics that differ from training data: `params` is async
(`const { clinic } = await params`), the typed global is `PageProps<"/alta/[clinic]">`, and
middleware is `src/proxy.ts` — whose matcher is already only `/dashboard/:path*` and
`/admin/:path*`, so **a public route needs no auth change**.

Branding is applied by setting `ClinicTemplate.hexBackgroundColor` as an inline CSS variable
on a wrapper, so the existing Tailwind v4 `@theme inline` tokens re-theme for free.
`globals.css` is already structured for that. Contrast must be computed rather than assumed —
the wallet branch measured `#2b211c` on `#808080` at **3.98:1**, below AA — so reuse the
`textColorFor()` approach already in `template-form.tsx:31-40` rather than inventing another.

**The phone normalizer is duplicated, not shared.** There is no monorepo or shared package, and
inventing one for one function is disproportionate. The duplicate carries a comment naming the
backend file as authoritative and the same vector table as a test; the backend remains the
decider, and a disagreement surfaces as a server-side 422 the form renders.

Copy is hardcoded Spanish, matching the rest of the app. There is **no i18n mechanism** — the
"language switch" commit was a find-and-replace of English strings into JSX, so there is
nothing to plug into. Building one is out of scope and worth its own task.

### 2.3 Rewire the staff member-form

`src/components/dashboard/member-form.tsx` collapses phone and email into one
`identity: z.string().min(5)` with no format check. Against the new CHECK constraint, an
unnormalized phone is now a **500 from Postgres**, so this cannot be left alone once Part 1
lands.

- Split `identity` into `phone` (required, normalized) and `email` (optional).
- Reuse `src/lib/phone-es.ts`.
- Post to `/clinics/:slug/members`, which needs the clinic's slug in the session. `auth.ts:48`
  hardcodes `clinicId: "clinic-aurea"`; add `clinicSlug` alongside it.

**Two assumptions here, flagged rather than buried.** Staff-entered members will *require* a
phone, which drops the email-only path the current form technically allows — that path is
incompatible with phone-as-identity and produces members no SMS can reach. And staff cannot
give consent on a client's behalf, so the form sends `consentMarketing: false` with
`consentSource: "staff_entry"`; a client who wants marketing opts in through the public form.
Say so if either is wrong, because both change the endpoint.

### 2.4 Real QR codes

Three hand-rolled CSS grids currently *look* like QR codes and encode nothing —
`member-form.tsx:109-122`, `template-form.tsx:236-249`, `ui/wallet-pass.tsx:~56`. The
scan-and-credit loop therefore has no working artifact, even though the scanner
(`@zxing/browser`) is real.

- Add `qrcode.react`, SVG renderer — SVG prints sharp at poster size, canvas does not.
- Replace all three grids.
- Add a panel to the existing `/dashboard/settings` page rendering the clinic's `/alta/<slug>`
  QR at print size. That printed code is the physical artifact this whole feature depends on,
  and settings is where a clinic already goes for its own configuration — a new route would be
  a third place to look.
- `template-form.tsx`'s preview QR should encode a sample member URL, not noise.

---

## Task order

Each step ends in a command that must pass.

1. **Pre-flight against Supabase** — run the two queries in §1.3. If duplicates exist, stop and
   resolve them with Satyam before writing any migration.
2. **Rebase `feat/membership-signup` onto `main`**; resolve the three conflicts. Delete the old
   migration directory. → `npm run lint && npm run typecheck`
3. **Schema + re-dated migration** → `npx prisma migrate dev`, then `npx prisma migrate reset --force` to prove it replays
4. **Merge the seeds**, clinics + presets + templates → `npx prisma db seed` twice
5. **Adapt services and tests** to `name` / uuid / nullable phone → `npm test`
6. **Merge `routes/v1/index.ts`**, verify both route families respond → `npm run build`
7. Open the backend PR. **Ends the backend critical path.**
8. **Frontend: `npm install`, `.env.example`, `apiMutate`, path prefixes** → `npm run build`
9. **Public `/alta/[clinic]` route + form + normalizer port** → manual verification, §Verification
10. **Staff form rewire** → manual verification
11. **Real QR + the poster panel** → scan the rendered QR with a phone and land on the form

---

## Verification

**Backend** — `npm run lint && npm run typecheck && npm test && npm run build`, plus the
existing integration suite, which already proves the unique index, the phone CHECK and the
concurrent sign-up race against a real Postgres. Re-point its fixtures at the reconciled
schema; the assertions themselves stand.

**The end-to-end test that matters** — this feature is a physical object in a waiting room, so
verify it as one:

1. Seed, start the backend, start the frontend.
2. Open the dashboard QR panel and **scan the on-screen QR with a real phone.**
3. It must land on `/alta/aurea`, branded with `AURÉA`'s template colour and program name.
4. Submit `612 34 56 78` → success state.
5. Submit `+34 612 34 56 78` from a different device → same success, and the database still
   holds **one** row with `signupCount` 2 and an unchanged `name`.
6. Stop the backend and submit again → the form must show a visible failure. This is the
   regression test for §2.1; before the fix it would have reported success.

---

## Hazards on `main` that this branch does not fix

Named because they are now load-bearing for a public feature, not to assign blame:

| | |
|---|---|
| **Template API is unauthenticated** | `templates.controller.ts:8-15` scopes by an `x-clinic-id` header or `?clinicId=` query with no auth, so any caller can read or overwrite **any** clinic's template — including the branding and colours the public page renders. The most serious item here. |
| **Raw error messages leak again** | `handleControllerError` returns `error.message` on a 500, re-introducing inside the templates module exactly what the foundation commit fixed at app level. A Prisma failure there ships connection detail to the caller. |
| **Login is client-side only** | `local-login-form.tsx:12` hardcodes `voone123` and grants roles by writing `voone-dev-role` cookies, so anyone can set `voone_admin` in devtools while `AUTH_ENABLED !== "true"`. Fine for a demo; worth knowing before a public route sits beside it. |
| **Two error conventions coexist** | His per-method `try/catch` and this branch's `AppError` + `asyncHandler`. Both work; converging them is a follow-up. |
| **No privacy policy exists** | Still true, and the consent flow references a version that no document backs. A launch blocker, not an engineering one. |
| **Templates module has no tests** | The 6 tests on `main` are all the foundation's. |
| **`voone-web` has no remote** | Cannot be pushed or pulled; its dirty tree is unbacked-up. |
