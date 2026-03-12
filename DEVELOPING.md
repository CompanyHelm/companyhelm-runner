# Developing CompanyHelm Runner

This document is for people working on the `@companyhelm/runner` codebase.

## Prerequisites

- Node.js 24+
- npm
- Docker

Install dependencies:

```bash
npm install
```

## Common Commands

Build the runner:

```bash
npm run build
```

Run all tests:

```bash
npm test
```

Run unit tests only:

```bash
npm run test:unit
```

Run integration tests only:

```bash
npm run test:integration
```

Run the manual Codex device-auth system test:

```bash
COMPANYHELM_RUN_MANUAL_DEVICE_AUTH_TEST=1 npm run test:system:device-auth
```

This test is intentionally skipped during normal `npm test` runs and in CI/PR environments. It launches the real runtime container, prints the live device code, waits for browser login completion, and then verifies that `auth.json` was copied back into the runner config directory and the Codex SDK state was marked `dedicated/configured`.

Run the built runner locally:

```bash
npm start -- --help
```

## Database Migrations

Generate SQL migrations from the Drizzle schema:

```bash
npm run db:generate
```

Apply migrations to the default local state DB:

```bash
npm run db:migrate
```

Override the target DB when needed:

```bash
DRIZZLE_DB_PATH=/absolute/path/to/state.db npm run db:migrate
```

## Regenerating Codex App Server Types

To regenerate the Codex App Server TypeScript schemas, run:

```bash
npm run generate:codex-app-server
```

This runs `codex app-server generate-ts` inside `companyhelm/runner:<version>` and writes the generated files to `src/generated/codex-app-server/`.

Commit generated changes together with the code that depends on them.

## Thread-Level MCP E2E Check

Use the runtime helper to validate thread-level MCP behavior for:

- a local known-good stdio MCP server (`local_echo`)
- Context7 stdio MCP (`resolve-library-id`, `query-docs`)

Prerequisites:

- CompanyHelm API is running and reachable at `http://127.0.0.1:4000/graphql` or another URL you pass explicitly
- GraphQL auth is available via `API_AUTH_BEARER_TOKEN`, `--auth-bearer-token`, or a CompanyHelm e2e context file
- at least one connected runner exists for the target company with the `codex` SDK and an available model

Run:

```bash
scripts/runtime/e2e-thread-mcp --company-id <company-id>
```

The script exits non-zero on failed assertions and prints a JSON summary on success.

## Source Conventions

- Do not create or use `index.ts` files for project source modules.
