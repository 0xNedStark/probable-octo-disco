# Rooftop Solar Platform (MVP)

AI-native residential rooftop solar orchestration for Uttar Pradesh (DVVNL), per
[`docs/PLAN.md`](docs/PLAN.md). This repo currently implements **weeks 1–4**:
foundation, lead capture, bill upload, the project state machine and ops console
(weeks 1–2), plus the solar calculator, versioned configuration, quotes and customer
proposals, and the AI Bill Agent (weeks 3–4).

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
- **Every customer-visible number comes from `packages/calc`** using a versioned config bundle
  (tariff, subsidy, price book, lenders, site). Each quote stores its inputs, config version ids,
  config hash and calc version, and can be reproduced exactly; stored quote calculations and
  published config are immutable at the database level.
- **A quote priced from a placeholder price book cannot be sent.** The seed price book is a
  placeholder until supplier quotes are entered in `/ops/config`.
- **The AI never confirms anything.** The Bill Agent writes a _proposed_ reading; a person reviews it
  against the bill and confirms. Only confirmed readings feed quotes. Every model call is logged in
  `ai_actions` (ids and metrics only, no document content).

## Local development

Requires Node 22+, pnpm 10, PostgreSQL 16.

```bash
cp .env.example .env                 # then edit the seed admin password
createdb solar && createdb solar_test && createdb solar_e2e   # or use the SQL below
pnpm install
set -a; . ./.env; set +a
pnpm db:migrate
pnpm db:seed                         # creates the admin user from SEED_ADMIN_* and seeds UP/DVVNL config
pnpm dev                             # http://localhost:3000 and /ops
pnpm worker                          # in another terminal: delivers outbox messages (logs them for now)
```

Databases as SQL: `CREATE USER solar WITH PASSWORD 'solar' CREATEDB; CREATE DATABASE solar OWNER solar;`
(repeat for `solar_test`, `solar_e2e`).

## Bill Agent (optional)

Set `AI_BILL_EXTRACTION=on` and Anthropic credentials (`ANTHROPIC_API_KEY`) for the worker. Uploaded
bills are then read by Claude (`claude-opus-5-5`, structured output, server-side fallback on refusal)
and pre-fill the review form. Low-confidence or invalid fields route to manual review
(`AI_BILL_CONFIDENCE_THRESHOLD`, default 0.9). With it off, everything works manually.

Before relying on it, run the eval on real labelled bills (keep them out of git):

```bash
AI_BILL_EXTRACTION=on pnpm --filter @solar/integrations eval:bills ./path/to/bills 0.9
```

Each `name.pdf|jpg|png` needs a `name.json` label with `consumerNumber, discom, tariffCategory,
sanctionedLoadKw, periodStart, periodEnd, unitsKwh, amountRupees`. The plan's gate is ≥95% field
accuracy (and high precision above the threshold) before auto-quoting.

## Checks

```bash
pnpm typecheck
pnpm test        # domain unit tests + db/worker integration tests (uses TEST_DATABASE_URL)
pnpm e2e         # Playwright: builds the app and runs against solar_e2e
pnpm format:check
```

After changing `packages/db/src/schema.ts`: `pnpm db:generate` and commit the new migration.
After changing calculation logic: bump `CALC_VERSION` in `packages/calc/src/engine.ts` and regenerate
golden outputs with `UPDATE_GOLDEN=1 pnpm --filter @solar/calc test`.

## Not built yet (next phases, see PLAN §9)

Payments and booking advance, customer click-wrap acceptance (OTP), WhatsApp BSP adapter and
Sales Agent (weeks 5–6); survey PWA, engineering review, installer portal, procurement,
regulatory checklist config. Known gaps: staff TOTP, customer OTP, shared (multi-instance) rate
limiting, orphaned-upload cleanup, server-side PDF rendering (proposals print to PDF from the browser).
