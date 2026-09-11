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

### Seeding a deployed environment

`prisma db seed` runs `tsx`, which is a devDependency, so it will **fail on a production
install where dev dependencies are pruned**. A fresh deployment therefore comes up with no
clinics, and every sign-up returns 404 until it is seeded. Run it once per environment as a
release step:

```bash
npx prisma db seed
```

Moving the clinics into a migration would remove this step; that is deliberately left for
when clinic provisioning gets a real surface.

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
