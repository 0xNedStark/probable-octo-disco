# Rooftop Solar Platform (MVP)

AI-native residential rooftop solar orchestration for Uttar Pradesh (DVVNL), per
[`docs/PLAN.md`](docs/PLAN.md). This repo currently implements **weeks 1–2**:
foundation, lead capture, bill upload, the project state machine and the ops console
used to run real projects by hand (concierge mode) while automation is built.

## Layout

| Path                    | What                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/domain`       | Pure TS: project stages, workstream state machines, gates, facts, roles, tasks. No I/O.           |
| `packages/db`           | Drizzle schema + migrations, and the services that own every write (transitions, events, outbox). |
| `packages/integrations` | Storage (local / S3), upload validation, notifier (log now; WhatsApp BSP next).                   |
| `apps/web`              | Next.js: landing + lead form, ops console (`/ops`), bill file serving.                            |
| `apps/worker`           | Outbox dispatcher (customer notifications).                                                       |

Key rules, enforced in code:

- **Every state change goes through `transitionStage` / `transitionWorkstream` / `recordFact`**, which lock the
  project row, check the domain gates, and write an append-only `project_events` row in the same transaction.
  `project_events` and `project_facts` reject UPDATE/DELETE at the database level.
- **Customer messages are written to the `outbox` in the same transaction** and delivered by the worker, so a
  rolled-back change never notifies anyone.
- **Facts** (quote sent, booking advance received, engineer approval, …) are recorded by authorised roles
  with a mandatory note until the owning modules exist; then those modules record them as `system`.
- Every human checkpoint is a **task** with an SLA; completing one requires the minutes spent
  (the "ops hours per project" metric).

## Local development

Requires Node 22+, pnpm 10, PostgreSQL 16.

```bash
cp .env.example .env                 # then edit the seed admin password
createdb solar && createdb solar_test && createdb solar_e2e   # or use the SQL below
pnpm install
set -a; . ./.env; set +a
pnpm db:migrate
pnpm db:seed                         # creates the admin user from SEED_ADMIN_*
pnpm dev                             # http://localhost:3000 and /ops
pnpm worker                          # in another terminal: delivers outbox messages (logs them for now)
```

Databases as SQL: `CREATE USER solar WITH PASSWORD 'solar' CREATEDB; CREATE DATABASE solar OWNER solar;`
(repeat for `solar_test`, `solar_e2e`).

## Checks

```bash
pnpm typecheck
pnpm test        # domain unit tests + db/worker integration tests (uses TEST_DATABASE_URL)
pnpm e2e         # Playwright: builds the app and runs against solar_e2e
pnpm format:check
```

After changing `packages/db/src/schema.ts`: `pnpm db:generate` and commit the new migration.

## Not built yet (next phases, see PLAN §9)

Quote engine and calc (weeks 3–4), Bill Agent extraction, payments, WhatsApp BSP adapter,
survey PWA, installer portal, procurement, regulatory checklist config. Known week-1–2 gaps:
staff TOTP, phone OTP for customers, shared (multi-instance) rate limiting, orphaned-upload cleanup.
