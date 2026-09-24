# Voone Backend Service

Plain Node.js + TypeScript backend for Voone, using Express.

## Structure

```text
src/
  app.ts                  Express app construction and middleware registration
  server.ts               HTTP server startup
  config/                 Environment loading and validation
  routes/v1/              Versioned HTTP routes
  modules/                Future business modules by domain
  wallet/engine/          Provider-independent wallet contracts and orchestration
  wallet/providers/       Provider-specific Apple and Google implementations
  infrastructure/         Database, queue, cache, and storage adapters
  jobs/                   Background jobs and workers
  common/                 Shared errors, logging, middleware, and utilities
```

The `wallet/engine` folder is for provider-independent wallet behavior, shared pass data types, and interfaces used by the rest of the app. The `wallet/providers` folder is reserved for concrete Apple Wallet and Google Wallet implementations. Those provider implementations are intentionally not started yet.

Domain modules under `src/modules` hold `clinics` and `members`; the rest are still placeholders. Authentication is intentionally not implemented — every endpoint below is public.

## API

| Endpoint                             | Purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `GET /api/v1/health`                 | Liveness. Needs no database.                                |
| `GET /api/v1/clinics/:slug`          | Public branding for the sign-up form a QR poster points at. |
| `POST /api/v1/clinics/:slug/members` | Membership sign-up. Name + phone + marketing consent.       |

Sign-up is idempotent per clinic: the same phone number submitted again returns the same
response and bumps a counter rather than creating a second member or failing. The response
body is byte-identical whether the member was created or already existed, deliberately — a
distinguishable response would reveal whether a phone number belongs to a member of a named
clinic.

```bash
curl -X POST http://localhost:4000/api/v1/clinics/aurea/members \
  -H 'Content-Type: application/json' \
  -d '{"fullName":"Verónica Navarro","phone":"612 34 56 78","consentMarketing":false}'
```

## Local Development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy environment variables:

   ```bash
   cp .env.example .env
   ```

3. Start local Postgres and Redis:

   ```bash
   docker compose up -d
   ```

4. Run the initial Prisma migration:

   ```bash
   npm run prisma:migrate
   ```

5. Seed the demo clinics:

   ```bash
   npm run prisma:seed
   ```

6. Start the dev server:

   ```bash
   npm run dev
   ```

The health endpoint is available at `GET /api/v1/health`.

### Seeding

`npm run prisma:seed` inserts two **demo** clinics with templates, for local development.
It is not needed in a deployed environment and should not be run in one: those clinics are
fictional, and real ones need a provisioning flow.

The `TemplatePreset` rows a clinic needs before it can create a template are reference
data, so they live in a migration (`20260916160000_seed_template_presets`) and are applied
by `prisma migrate deploy` in `preDeploy`. That is deliberate: they used to be seeded, and
`prisma db seed` runs `tsx` — a devDependency — so it fails on a production install where
dev dependencies are pruned, leaving an environment with no presets and no way to notice
until a clinic tried to onboard.

## Deployment (Railway)

The service is defined as code in `.railway/railway.ts` — a partial describing one service
inside the existing `voone-web` project, matching how the marketing site declares itself.

`preDeploy` runs `prisma migrate deploy` before the new version takes traffic, so the code and
the schema are never live at different versions. **`DATABASE_URL` must therefore point at
Supabase's session pooler (port 5432).** The transaction pooler (6543) cannot run DDL or hold
the advisory lock Prisma takes, so a deploy configured against it fails in `preDeploy`.

The health check is `/api/v1/health`, which needs no database — Railway's default of `/` would
mark every deploy unhealthy, since nothing is served there.

### Variables to set on the service

| Variable                              | Notes                                                                                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                        | Supabase **session** pooler, port 5432. A `@` in the password must be percent-encoded as `%40`, or libpq splits the URL on the wrong `@` and the host fails to resolve. |
| `REDIS_URL`                           | A reference to the managed `voone-redis` instance declared in the IaC, not a pasted string. Read by the wallet sync queue when `WALLET_SYNC_MODE=queue`.                |
| `PORT`                                | Injected by Railway.                                                                                                                                                    |
| `FRONTEND_URL`                        | CORS origin. Single origin only — a clinic-branded form on another domain fails with an opaque browser error and no server-side log.                                    |
| `GOOGLE_WALLET_ISSUER_ID`             | Google Pay & Wallet Console.                                                                                                                                            |
| `GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL` |                                                                                                                                                                         |
| `GOOGLE_WALLET_SERVICE_ACCOUNT_KEY`   | PEM with escaped newlines.                                                                                                                                              |
| `GOOGLE_WALLET_ALLOWED_ORIGIN`        | Origins allowed to host a "Save to Google Wallet" button.                                                                                                               |
| `EDGE_SHARED_SECRET`                  | Optional. Set it with a matching Cloudflare Transform Rule to reject requests that bypass the edge and reach the origin directly. Unset, that guard is a no-op.         |
| `APPLE_WALLET_*`                      | Signing material: organization name, signer cert, signer key, key passphrase, WWDR cert. The pass type and team identifiers are read off the certificate, not set.      |
| `APPLE_PASS_WEB_SERVICE_URL`          | Baked into every signed pass and unchangeable afterwards — a pass on a member's phone calls this host forever. Unset, the pass web service routes are not mounted.      |
| `CARD_REDEMPTION_SECRET`              | Keys the HMAC behind every member's barcode. Rotating it changes every issued barcode at once.                                                                          |
| `WALLET_SYNC_MODE`                    | `inline` (code default, no infrastructure) or `queue` (Redis + BullMQ). Production runs `queue`; `voone-redis` must be up before it is set.                             |
| `WALLET_WORKER_IN_PROCESS`            | `true` by default: the API consumes the queue itself. Set `false` only once a dedicated worker service runs `npm run worker`, or nothing consumes and cards go stale.   |

A freshly deployed environment has no clinics until it is seeded — see above.

## Scripts

- `npm run dev` starts the TypeScript server with hot reload.
- `npm run build` generates the Prisma client and compiles TypeScript.
- `npm start` runs the compiled server.
- `npm run lint` runs ESLint.
- `npm test` runs the suite. Parts of it need a database — see Local Development.
- `npm run typecheck` runs TypeScript without emitting files.
- `npm run format` formats files with Prettier.
- `npm run prisma:migrate` applies migrations in development.
- `npm run prisma:seed` inserts the demo clinics. Safe to re-run.
- `npm run worker` runs the wallet sync worker as its own process. Only needed when
  `WALLET_SYNC_MODE=queue` and `WALLET_WORKER_IN_PROCESS=false`.
