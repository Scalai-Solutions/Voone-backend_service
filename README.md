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

Domain modules under `src/modules` are placeholders only. Authentication is also intentionally not implemented in this skeleton.

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

5. Start the dev server:

   ```bash
   npm run dev
   ```

The health endpoint is available at `GET /api/v1/health`.

## Scripts

- `npm run dev` starts the TypeScript server with hot reload.
- `npm run build` generates the Prisma client and compiles TypeScript.
- `npm start` runs the compiled server.
- `npm run lint` runs ESLint.
- `npm run typecheck` runs TypeScript without emitting files.
- `npm run format` formats files with Prettier.
