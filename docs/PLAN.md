# AI-Native Solar MVP — Implementation Plan (v2)

Source: *AI-Native Solar MVP — Product & Execution Specification v1.0 (Oct 2026)*.
**v2.1:** launch geography set to UP/DVVNL; adds §3A–3D (UP specifics, SBI financing, payment milestones and refunds, engineering approval).
This plan is the reviewed and revised version of the first-pass plan. §2 lists what changed and why.

---

## 1. Design summary

**Product.** A residential rooftop-solar platform for India. The customer uploads an electricity bill. The platform then sizes the system, quotes it, estimates subsidy and financing, and coordinates the survey, installer, procurement, QA, DISCOM process and handover.

**MVP scope.** 2–10 kW homes (mostly 3–5 kW) in one geography. 1–2 regulated lending partners. A partner installer network. Pilot target: **10–20 real installations with clean per-project unit economics.**

**Business model.** EPC/orchestration margin. Lending, manufacturing and most physical work go to partners. We never lend from our own balance sheet and never present ourselves as the lender.

**Core principle.** Deterministic backbone, AI around it.
- A project state machine with an immutable event log is the business truth.
- A versioned calculation engine produces every number shown to a customer.
- Catalogue, price book, tariffs, subsidy rules and lender terms are configurable data.
- AI agents (Sales, Bill, Finance, Project, Support, QA Copilot, Ops Copilot) act only through typed tools. They never invent prices, sizes, subsidies or loan terms. Every AI action is logged with its prompt and model version. High-risk actions need human approval.

**Channels.** Web plus WhatsApp for customers (WhatsApp is the primary interface). A mobile-first PWA for technicians and installers. An ops console for the internal team.

---

## 2. Review of plan v1 — what changed and why

| # | Problem in v1 | Change in v2 |
|---|---|---|
| 1 | **Timeline assumed software must exist before projects move.** A rooftop project takes weeks to months (lender sanction, DISCOM feasibility, net-meter, inspection). Starting real projects at week 9 means none would be commissioned by week 12. | **Concierge-first.** A thin ops console that can move any project manually ships in weeks 1–2. Real leads go through it from week 3. Automation replaces manual steps one by one, and the pilot runs alongside the build. |
| 2 | **Single linear state list.** Finance, DISCOM, procurement and installation actually run in parallel, and DISCOM feasibility usually has to be approved *before* installation, not after QA as the spec's linear order implies. | **Stage + workstreams model** (§4). A coarse project *stage* for customers and dashboards, plus independent workstream state machines (finance, regulatory, procurement, installation, payments). Stage transitions are gated on workstream states. |
| 3 | **Payments were missing.** There was no booking advance, milestone collection, lender-disbursement tracking, installer payouts or reconciliation, and procurement could commit cash before funds were secured. | Payments workstream, ledger and payment-gateway integration. **Procurement is gated on "funds secured"** (advance received, plus loan sanctioned/disbursed or full payment). |
| 4 | **No human-task model.** The spec's metric "human ops hours per project" could not be measured, and approvals had no queue. | A generic `tasks` table (assignee, SLA, due date, effort minutes) backs every human checkpoint. It drives the ops inbox, SLA alerts and the ops-hours metric. |
| 5 | **The ops dashboard arrived in week 11.** | The ops console is the *first* UI built. Appendix B questions are answered progressively, from week 2. |
| 6 | **Regulatory specifics were not modelled.** PM Surya Ghar runs through a national portal with consumer registration, vendor selection, DISCOM feasibility, installation, net-meter, inspection and subsidy release. Since 1 June 2026, net-metered projects claiming central subsidy need DCR modules with ALMM List-II cells. | The regulatory workstream mirrors the portal's steps as configurable checklists per DISCOM. The catalogue carries `dcr`, `almm_list1` and `almm_list2_cells` flags, and the calc engine only offers subsidy-eligible configs when those flags hold. **Vendor-of-record decision** added to week 0 (§3). |
| 7 | **Compliance treated as a later workstream.** Facilitating loans likely makes us a Lending Service Provider under the RBI Digital Lending Directions 2025, with obligations on consent, data residency in India, no fund pass-through, neutral offer display, KFS display and grievance officers. The DPDP Act also applies, and the Aadhaar Act restricts storing Aadhaar numbers. | Compliance-shaped architecture from day one: consent ledger, India-region hosting, **KYC collected by the lender, not by us** where possible, no loan money through our accounts, masked identifiers, retention policy, grievance flow. Legal sign-off is a week-0 dependency. |
| 8 | **Over-engineered monorepo** (7 packages) for a 1–2 engineer team, which runs against the spec's "don't build a complex framework". | 2 apps + 4 packages (§6). AI and messaging adapters live in one `integrations` package. |
| 9 | **Temporal vs. simpler approach left open.** | Decided: Postgres state machine + **pg-boss** job queue + transactional outbox. Revisit Temporal only if workflows outgrow it. |
| 10 | **Calculator inputs were underspecified.** No slab tariffs, fixed charges, sanctioned-load limits, location yield or indicative vs. final quotes. | Calc spec in §7, with two quote grades (*indicative* from the bill, *final* after survey) and money in integer paise. |
| 11 | **Long-lead external items** (WhatsApp business verification and template approval, lender agreements, vendor registration of 7–15 working days, supplier quotes) were on the critical path but not scheduled. | A **week-0 business track** with owners (§3). |
| 12 | **No scope-cut ladder.** A 12-week plan with no fallback. | §11 defines what gets cut, in order, if the build slips. |
| 13 | **AI evaluation was vague.** | Collect 50+ real bills from the launch DISCOM in week 0 as an eval set. Accuracy gate before auto-quoting. Manual-entry fallback always available. |
| 14 | **Fraud and evidence controls were generic.** | Client-side capture of photo EXIF/geotag/timestamp, server-side hash, perceptual-hash duplicate detection across projects, random-audit sampling. |

---

## 3. Week 0 — decisions and long-lead items (start immediately, run in parallel)

| Item | Why it's on the critical path | Owner |
|---|---|---|
| Launch state/DISCOM | Sets tariff, bill format, feasibility rules and state top-up subsidy | Founder |
| **Vendor-of-record for the subsidy** | Under PM Surya Ghar, installs claiming subsidy go through a registered vendor. Either register ourselves (needs GST, licence, a reference project; ~7–15 working days to activate) or run the pilot with a registered installer partner as vendor of record. This changes payment flows and contracts. | Founder + legal |
| Legal opinion: LSP status, customer/installer contracts, refund policy, privacy notice, consent text | Shapes the finance flow and what data we may hold | Founder + counsel |
| Lending partner(s) | Integration mode (API / portal / manual), required documents, KFS format, disbursement flow. Consider PSU banks under the scheme alongside an NBFC. | Founder |
| WhatsApp BSP + Meta business verification + template submission | Verification and template approval take days to weeks. Outbound messages outside the 24-hour window need approved templates. | Eng |
| Supplier quotes for DCR modules, inverters and BOS from 2–3 distributors | Seeds price book v1. Equipment cost dominates margin. | Ops |
| 3–5 installer partners, rate card, payout terms | Needed before the first survey | Ops |
| 50+ anonymised bills from the target DISCOM | Bill-AI eval set and calc test fixtures | Sales/Ops |
| Hosting account in an India region | Data residency | Eng |

**Decided (v2.1):**
- **Geography:** Uttar Pradesh, DVVNL (Dakshinanchal Vidyut Vitran Nigam). Launch city to be chosen within DVVNL territory, e.g. Agra. Customer language: Hindi/Hinglish.
- **Vendor of record:** a DVVNL-empanelled installer partner (founder is sourcing one). We orchestrate; they hold the portal vendor role. See §3A for implications.
- **Lender:** SBI under PM Surya Ghar is the primary candidate (to be confirmed). See §3B.
- **Subsidy recipient:** the customer (central and UP state). Confirmed against public sources (§3A); re-confirm with the vendor partner.
- **Booking advance and refunds:** proposed in §3C.
- **Engineering approval:** proposed in §3D.

**Remaining defaults if not overridden:** Meta Cloud API via a BSP; Claude for vision and structured extraction; AWS ap-south-1 (Mumbai) for compute, Postgres and S3; Razorpay for payments.

## 3A. UP / DVVNL launch specifics

All figures below are **seed config**, not code. Re-verify each with the vendor partner and UPNEDA before go-live.

| Item | Current public understanding | Plan impact |
|---|---|---|
| Central subsidy (PM Surya Ghar) | ₹30,000/kW for the first 2 kW, ₹18,000 for the 3rd kW, capped at ₹78,000 for ≥3 kW | `subsidy_rules` row `central_psg_v1` |
| UP state subsidy (UPNEDA) | ₹15,000/kW, capped at ₹30,000 | `subsidy_rules` row `up_state_v1`; combined maximum ₹1,08,000 at ≥3 kW |
| Who receives the subsidy | **Customer**, by direct bank transfer after DISCOM commissioning inspection | The customer pays the **full price** up front (cash + loan). The subsidy arrives later, typically weeks after commissioning. The proposal must show "price", "you pay now" and "subsidy you receive later", not just a net price. The project tracks `SUBSIDY_RELEASED` as a follow-up and proactively helps the customer if it stalls. |
| Eligibility | Residential, net-metered, DCR modules (ALMM List-I modules with List-II cells for systems commissioned from 1 June 2026), installed by an empanelled vendor | Catalogue flags enforced by calc; vendor-of-record recorded per project |
| DVVNL process | Consumer registers on pmsuryaghar.gov.in with their DVVNL consumer number → selects the vendor → DISCOM feasibility (roughly 15–30 days reported) → installation → upload system details and geo-tagged photos on the portal → DVVNL inspection and net-meter (roughly 10–20 days for meter; 2–4 weeks for inspection reported) → subsidy request → release | Seed `regulatory_checklists` for DVVNL with these steps. Each step stores the portal reference and an evidence upload. Expected durations drive SLA alerts and customer ETAs. |
| Tariff | UPERC domestic slab tariff, with fixed charges per kW of sanctioned load | Seed `tariffs` for UP domestic. Savings calc keeps fixed charges. |
| Sanctioned load | System size above sanctioned load may need a load-enhancement application | Calc flags it; the regulatory checklist adds a load-enhancement step |

**Implications of a partner as vendor of record:**
- On the national portal the customer selects the partner. Our system stores `vendor_of_record_id` per project and tracks portal steps the partner performs, with our ops doing the chasing.
- **Billing model needs a CA/legal decision.** Either (a) the partner invoices the customer and pays us an orchestration fee, or (b) we invoice the customer and subcontract the partner. Subsidy and lender paperwork usually expect the vendor's invoice, which favours (a) for the pilot. The data model gets a `billing_entity` per project so either model works, and the margin report handles both.
- Commercial agreement with the partner must cover: fee or margin split, SLAs, portal responsiveness, warranty ownership, the right to audit evidence, and non-solicitation of our customers.

## 3B. Financing: SBI under PM Surya Ghar (to be confirmed)

Current public understanding, to verify directly with SBI:
- Rooftop loan for systems up to 3 kW: about ₹2 lakh, collateral-free, concessional rate linked to EBLR (reported as roughly 7%), tenor up to 10 years, about 10% margin money paid by the customer.
- Larger systems (>3 kW, up to 10 kW) fall under a different product at a higher rate.
- The customer applies online via the JanSamarth portal or the bank.

**What this means for the product:**
- **The customer is the applicant; we assist.** We prepare a document checklist, help fill the application, and track status from customer- or partner-supplied updates. We do not collect KYC into our system beyond what the customer chooses to share for assistance, which also keeps us clear of a lending-service-provider role. Legal confirms this in week 0.
- **Strong sizing nudge:** a 3 kW system fits the collateral-free ₹2 lakh product and the maximum combined subsidy. The calc engine marks the "sweet-spot" configuration. Recommend larger systems only when consumption justifies them.
- Seed `lender_products`: `sbi_psg_upto3kw_v1` and `sbi_rooftop_gt3kw_v1`. EMI is labelled *illustrative* until SBI sanctions.
- **To confirm with SBI or the partner:** whether disbursement goes to the vendor's account (and in what tranches), and the exact documents needed. This determines when procurement can safely start.
- Cash and other lenders stay supported through the generic finance workstream.

## 3C. Booking advance, payment milestones and refunds (proposal)

Principles: low friction to start, money collected roughly in step with our cost exposure, and refunds generous where *we* or a third party block the project. The figures are pilot defaults stored in config, to be reviewed with legal/CA.

| Step | Cash customer | SBI-loan customer |
|---|---|---|
| Bill assessment and indicative proposal | Free | Free |
| **Booking token** on accepting the indicative quote (triggers survey) | ₹5,000 | ₹5,000 |
| On accepting the **final** quote (after survey), before portal application and procurement | Pay up to 40% of price (token counts towards it) | Margin money (about 10%, token counts towards it) |
| Material delivered to site | +50% | Loan disbursement (per SBI terms) |
| Net-meter installed / commissioning | Final 10% | Any balance not covered by the loan |

Procurement starts only when funds are secured: the cash 40% is received, or the SBI sanction letter is in hand (and the first tranche disbursed if SBI's terms require it).

**Refund policy (proposal):**

| When cancellation happens | Refund |
|---|---|
| Before survey | 100% of token |
| After survey, cancelled because the site is infeasible, the final price is more than 5% above the indicative quote, DVVNL feasibility is rejected, or the loan is rejected | 100% of everything paid |
| After survey, customer changes their mind, before procurement | Everything paid minus a ₹2,000 survey and design fee |
| After procurement, before installation | Everything paid minus actual non-recoverable costs (restocking or return fees, survey fee), shown as an itemised statement |
| After installation starts | No cancellation; warranty, defect and grievance process applies |

Refunds are processed within 7 working days of approval, to the original payment method, and each one is a ledger entry tied to a `refund` task with an approver. The policy text is versioned and shown at token payment, and the accepted version is stored in `consents`.

## 3D. Engineering approval (what it is and who does it)

**What it is.** After the technician's site survey, a qualified person checks that the proposed system is safe and will actually work on *this* roof before money is spent on equipment. The checks:
- roof type, strength and mounting structure
- shading and orientation, and whether the final kW is achievable
- string design (modules per string) matched to the inverter's voltage and current limits
- cable sizes, earthing, lightning arrestor, AC/DC protection
- sanctioned load vs. system size
- a final bill of materials

Sign-off moves the project to `DESIGN_APPROVED` and locks the final quote and BOM. The spec deliberately keeps this a human decision, not an AI one.

**Who does it (proposal).**
1. **Pilot default:** the vendor-of-record partner's engineer reviews and signs off inside our system. Their name and licence number are recorded on the approval, at no extra cost to us.
2. **Independent check:** a freelance electrical engineer, paid per review, audits a random sample (e.g. 1 in 5) plus every non-standard case (RCC vs. tin-shed exceptions, >5 kW, heavy shading, load enhancement).
3. **To keep reviews quick:** standard pre-engineered designs for 2/3/4/5 kW with fixed string layouts and BOMs. The review then becomes a guided checklist on the survey data (about 15–30 minutes), and only deviations need real engineering.

In the system this is just the `engineer` role plus a `design_review` task type, so whoever fills it can be changed without code changes.

---

## 4. Domain model: stage + workstreams

### 4.1 Project stage (coarse, customer-visible)
```
LEAD → QUALIFIED → QUOTED → BOOKED → SURVEYED → DESIGN_APPROVED
     → READY_TO_INSTALL → INSTALLED → QA_PASSED → COMMISSIONED → HANDED_OVER → CLOSED
side states (from any stage): ON_HOLD(reason) ↔ previous, CANCELLED(reason), LOST(reason)
```
The spec's 17 states map onto these stages plus workstream states, so nothing in the spec is lost.

### 4.2 Workstreams (each its own small state machine)
| Workstream | States | Notes |
|---|---|---|
| `bill` | RECEIVED → EXTRACTED → (NEEDS_RESUBMIT \| NEEDS_MANUAL) → CONFIRMED | Customer confirms the extracted values |
| `quote` | versions: INDICATIVE → FINAL; each SUPERSEDED / ACCEPTED / EXPIRED | Survey may change the final quote; acceptance must be re-confirmed if price changes beyond a tolerance |
| `finance` | NOT_REQUIRED (cash) \| DOCS_PENDING → SUBMITTED → SANCTIONED \| REJECTED → DISBURSED | Rejection → offer cash/alternate lender or LOST. A cash path skips finance. |
| `regulatory` | Per-DISCOM checklist: PORTAL_REGISTERED → FEASIBILITY_SUBMITTED → FEASIBILITY_APPROVED → … → NET_METER_INSTALLED → INSPECTED → COMMISSIONING_CERT → SUBSIDY_CLAIMED → SUBSIDY_RELEASED | Steps are config, not code. Load-enhancement step inserted if system size > sanctioned load where the DISCOM requires it. |
| `procurement` | DRAFT → APPROVED → ORDERED → DELIVERED (partial allowed) | PO approval is a human task |
| `installation` | ASSIGNED → ACCEPTED → SCHEDULED → IN_PROGRESS → SUBMITTED → QA_REJECTED (→ IN_PROGRESS) \| QA_APPROVED | Submission blocked until mandatory evidence is present (deterministic) |
| `payments` | ledger entries: booking advance, milestones, lender disbursement, subsidy (if routed via vendor), installer payouts, refunds | Double-entry-lite: every entry has a counter-account |

### 4.3 Key gates (enforced in `transition()`)
- `BOOKED` requires an accepted quote, recorded consent and a booking advance received (or waived by ops with a reason).
- `DESIGN_APPROVED` requires survey approved by an engineer and a FINAL quote accepted.
- `READY_TO_INSTALL` requires funds secured, `regulatory` ≥ FEASIBILITY_APPROVED, and procurement DELIVERED.
- `CLOSED` requires a commissioning certificate, a complete handover pack, a fully reconciled payments ledger and installer payout settled. Subsidy release is tracked but does not block closing.

Every transition writes a `project_events` row (actor type: user/agent/system, actor id, from, to, reason, payload, prompt/model version if an agent acted) **in the same DB transaction**, plus an `outbox` row for notifications.

---

## 5. Data model

The spec's 18 entities, plus the additions marked ➕.

- Identity: `users` (roles), `customers`, ➕`consents` (purpose, text version, channel, granted/withdrawn at), `leads`
- Bills: `electricity_bills` (file, sha256, source), `bill_readings` (fields, per-field confidence, confirmed_by)
- Config (all versioned, immutable once published): ➕`catalogue_items` (DCR/ALMM flags, warranty), ➕`price_books`, ➕`tariffs` (per DISCOM, slabs, fixed charges), ➕`subsidy_rules`, ➕`lender_products`, ➕`calc_versions`, ➕`regulatory_checklists`
- Sales: `solar_quotes` (grade, version, calc_version, config snapshot hash, inputs, outputs, status)
- Projects: `solar_projects` (stage, workstream states, SLA, ➕`vendor_of_record_id`, ➕`billing_entity`), `project_events`, ➕`tasks` (type, assignee, due, SLA, effort_minutes, outcome)
- Finance: `loan_applications` (lender ref, status, KFS ref — **no KYC documents unless legal requires it**)
- Field: `site_surveys`, `installers`, `installer_assignments`, `installation_tasks`, `installation_photos` (sha256, phash, exif, geo, ai_result, reviewer), `qa_results`
- Supply: ➕`suppliers`, `purchase_orders`, ➕`po_lines`, ➕`serial_numbers`
- Regulatory: `discom_applications` (portal ref, checklist step states)
- Money: `payments` → ➕`ledger_entries`, ➕`installer_payouts`, ➕`project_costs` (for the contribution-margin record)
- Comms: `messages`, ➕`outbox`, `support_tickets`
- AI: ➕`ai_actions` (agent, tool, prompt version, model, input/output refs, tokens, cost, latency, outcome)
- Docs: ➕`documents` (type, storage key, sensitivity class, retention-until)

Conventions: money is integer paise; IDs are ULIDs with readable prefixes (`SOL-`, `CUS-`); all timestamps are UTC `timestamptz`; soft delete only where retention rules allow.

---

## 6. Architecture

```
apps/web        Next.js (App Router): landing, customer portal, ops console, installer/technician PWA,
                webhooks (WhatsApp, payments, lender). Role-gated route groups. Zod-validated server actions.
apps/worker     pg-boss consumers: bill extraction, quote generation, outbox delivery, follow-ups,
                SLA timers, daily ops report, AI agents.
packages/domain State machines, gates, transition(), tasks, domain types. Pure TS, no I/O beyond a repo interface.
packages/calc   Deterministic solar + economics engine. Pure functions, semver-versioned, golden tests.
packages/db     Drizzle schema, migrations, seed config, repository implementations.
packages/integrations  ai/ (gateway), whatsapp/, storage/, payments/, lender/ adapters behind interfaces.
```

- **Hosting:** AWS ap-south-1. ECS Fargate (web + worker), RDS Postgres, S3 (separate bucket + KMS key for sensitive docs), CloudFront. IaC with Terraform or SST. Staging and prod environments.
- **Reliability:** transactional outbox for every outbound side effect; idempotency keys on all webhooks; retries with dead-letter queues; SLA timers as scheduled jobs.
- **Auth:** phone-OTP for customers and installers; email + TOTP for staff. Roles: `customer`, `sales`, `ops`, `engineer`, `finance`, `installer`, `technician`, `admin`. Row scoping: installers and technicians see only assigned projects, enforced in the repository layer and backed by Postgres RLS on sensitive tables.
- **Files:** direct-to-S3 presigned uploads, client-side compression, short-TTL signed reads, every read of a sensitive document logged.
- **Observability:** structured JSON logs, OpenTelemetry traces, Sentry, and an `ai_actions` cost/latency dashboard.
- **AI gateway** (`integrations/ai`): one entry point for all model calls, with schema-validated structured output (Zod), retries and fallbacks, a prompt registry with versions, PII redaction before sending, a per-call cost record, and a kill-switch per agent. Prefer an India-region model endpoint if available. Regardless, **KYC and financial documents are never sent to an LLM**.

---

## 7. Calculation engine (`packages/calc`)

**Inputs:** monthly consumption (12 months if on the bill, else extrapolated from available months with a seasonal profile), tariff (slabs, fixed charges, duties), sanctioned load, location (specific yield kWh/kWp/yr from a per-district table, sourced from PVGIS/NREL and stored as config), usable shadow-free roof area (indicative: customer estimate; final: survey), catalogue and price book, subsidy rules, lender products.

**Algorithm (v1):**
1. Target kWp = annual consumption ÷ specific yield × target offset (config, e.g. 90–100%).
2. Clamp by roof area (m²/kWp config), sanctioned load (or flag load enhancement), and scheme/regulatory caps.
3. Snap to the nearest approved standard config (e.g. 2, 3, 4, 5, 6, 8, 10 kW) and pick the module count and inverter from the catalogue (subsidy-eligible DCR config by default).
4. Price from the price book: modules, inverter, structure, BOS, installation, net-meter/DISCOM fees, margin.
5. Subsidy from the rules (central + state, capped), only if the config is eligible.
6. Finance: loan = price − subsidy-timing-adjusted upfront; EMI from lender product terms. Labelled *illustrative* until the lender sanctions.
7. Savings: slab-aware bill before vs. after (net-metering settlement rules per DISCOM), fixed charges retained, degradation (config) over 25 years. Simple payback and 3 scenarios (low / base / high yield).

**Outputs** as specified, plus `assumptions[]` (each with a source/config ref) so every customer-visible claim is traceable.

**Versioning:** `quote.calc_version` (package semver) plus `config_snapshot_hash` (hash of all config rows used). Re-running with both reproduces the quote byte-for-byte. A golden-file test suite of 50+ cases must pass before any calc release.

---

## 8. AI agents — rollout order

AI is added only after the manual version of each step works and has been measured.

| Agent | Weeks | Autonomy at launch | Gate to expand |
|---|---|---|---|
| Bill Agent (extraction) | 3–4 | Auto-accept if every required field ≥ threshold **and** customer confirms. Otherwise manual task. | ≥95% field accuracy on the eval set |
| Sales Agent (WhatsApp intent + FAQ + quote explanation) | 5–6 | Reads quote/project via tools, templated numbers only. Escalates on low confidence or negative sentiment. | <5% escalation errors over 2 weeks |
| Project Agent (reminders, chasing docs) | 7–8 | Sends approved templates on timers. No free-form promises of dates. | — |
| QA Copilot (photo pre-check) | 9–10 (P1) | Advisory only; a human approves every QA | Agreement with human QA ≥90% |
| Support Agent | 11 (P1) | Status/FAQ answers + ticket creation. Complaints always reach a human. | — |
| Ops Copilot (daily exception report) | 11 | Read-only | — |
| Finance Agent | 11+ | Status relay only, from lender-sourced data | Lender agreement allows it |

**Guardrails, enforced in code:** tools return facts and agents format them. A numeric-claim checker rejects any agent message containing a number that is not present in the tool outputs for that turn. Every agent action is logged to `ai_actions`. Each agent has a kill-switch. Supported languages: English, Hindi and Hinglish, plus the launch state's language.

---

## 9. Phased build (12 weeks + week 0)

Each phase states the **manual fallback** that keeps the live pilot moving.

| Weeks | Product build | Live pilot / business | Exit criteria |
|---|---|---|---|
| **0** | Repo, CI, envs, IaC skeleton | All of §3 | Decisions logged; BSP verification and lender talks started; bill eval set collected |
| **1–2** | Schema + migrations; auth and roles; `transition()` + event log + outbox; **ops console v0** (project list, detail, manual stage/workstream moves, tasks inbox); lead capture + consent + bill upload; manual bill-reading entry | — | A real lead is captured, its bill stored, readings entered manually, all events audited |
| **3–4** | `calc` v1 + golden tests; config admin (price book, tariff, subsidy rules); indicative quote + proposal page/PDF; Bill Agent v1 + eval harness | **First real proposals sent** (ops-triggered) | A valid bill gives a reproducible proposal in <5 min; bill-AI accuracy measured |
| **5–6** | Quote acceptance (OTP click-wrap); payments (booking advance via gateway, ledger); WhatsApp inbound/outbound + templates + Sales Agent v1; customer status timeline; finance workstream (manual/portal mode) | **First bookings**; first loan applications | Customer accepts and pays an advance on web or WhatsApp; finance status tracked |
| **7–8** | Technician PWA (survey checklist, mandatory photos, EXIF/geo capture, offline-tolerant uploads); engineer review → final quote + BOM; regulatory workstream with DISCOM checklist; installer portal (jobs, accept) | **First surveys; feasibility applications submitted** | A booked project reaches DESIGN_APPROVED with feasibility submitted |
| **9–10** | Procurement (PO generation from BOM, approval task, delivery, serials); installation checklist + evidence gating; QA review UI (+ QA Copilot advisory); installer payouts | **First installations** | First project reaches QA_PASSED; installer paid via the system |
| **11** | Appendix B dashboard complete; contribution-margin report per project; funnel and time-in-stage metrics; Support Agent; Ops Copilot daily report; handover pack generator | Document bottlenecks | 10+ projects tracked end to end, with no spreadsheets |
| **12** | Security review (permissions, RLS, sensitive-doc access audit), retention jobs, backup/restore drill, alerting, load and abuse tests on webhooks, runbooks | Pilot economics review | Pilot run with measurable unit economics. Commissioning tracked even where the DISCOM timeline goes past week 12. |

**Pilot exit, restated honestly:** by week 12, 10–20 projects *booked and progressing*, a first cohort *installed*, and commissioning plus subsidy release *tracked*. DISCOM timelines are outside our control and will often go past week 12.

---

### Progress

- **Weeks 1–2: built.** Monorepo; domain state machine with gates, facts and roles (full transition-matrix tests); Postgres schema with an append-only audit log; lead capture with consent ledger, bill upload (content-sniffed, hashed) and repeat-lead merging; manual bill-reading entry; tasks with SLA and effort capture; transactional outbox and worker; staff auth (scrypt, DB sessions, lockout); ops console (dashboard, project detail with gate checklist, workstreams, timeline, task inbox); access-logged bill viewing; CI; Playwright e2e for lead → QUALIFIED. Deferred: staff TOTP, customer OTP, S3 driver untested against real AWS.

## 10. Quality, testing and security

- **Domain:** a transition matrix test (every legal transition passes, every illegal one fails) plus property-based tests for gates.
- **Calc:** golden files, plus a property test: monotonic savings vs. size within the clamp range.
- **AI:** offline eval suites per agent (bill extraction accuracy, intent classification, numeric-claim checker) run in CI on prompt/model changes.
- **E2E:** Playwright happy path (lead → closed) plus key rework paths (bill resubmit, loan rejected → cash, QA rejected → rework, cancellation with refund).
- **Security:** least-privilege IAM, KMS-encrypted sensitive bucket, no Aadhaar numbers stored (masked only), data in India, secrets in AWS Secrets Manager, dependency scanning, quarterly access review.
- **Compliance artefacts:** privacy notice, consent text versions, retention schedule, grievance officer contact on site and WhatsApp, KFS display before any loan acceptance, neutral display if more than one lender.

---

## 11. Scope-cut ladder (if behind schedule, cut in this order)

1. Support Agent → a human answers from the ops console
2. QA Copilot → human-only QA
3. Customer web portal timeline → WhatsApp status messages only
4. Installer portal → ops enters installer updates on their behalf (evidence still uploaded through the technician PWA)
5. Payment gateway → manual bank-transfer entry into the ledger

**Never cut:** state machine + event log, versioned calc, consent ledger, evidence gating, human QA approval, the cost/margin record.

---

## 12. Metrics instrumentation (built in, not bolted on)

Each spec §17 metric and where its data comes from:
- Funnel conversion: `project_events` stage transitions
- Lead response time: first outbound message timestamp − lead created
- Quote time: quote created − bill confirmed
- Human ops hours/project: Σ `tasks.effort_minutes` (captured on task completion) + logged touches
- Defect rate: `qa_results` rejections per installation, by installer
- CAC: `leads.source/campaign` + marketing spend config
- Gross contribution: `project_costs` + `ledger_entries`
- Referral rate: `leads.source = referral`

---

## 13. Traceability to the spec's Definition of Done

| DoD item | Phase |
|---|---|
| Capture a lead | 1–2 |
| Receive and extract a bill | 1–2 (manual), 3–4 (AI) |
| Reproducible proposal | 3–4 |
| Explain financing, collect documents | 5–6 |
| Create and track a project | 1–2 |
| Structured site survey | 7–8 |
| Approved BOM | 7–8 |
| Assign and manage installer | 7–10 |
| Installation evidence | 9–10 |
| QA with exceptions | 9–10 |
| Grid/commissioning tracking | 7–8 (feasibility), 9–12 (post-install) |
| Notify customer on every state change | 5–6 (outbox + WhatsApp) |
| Revenue, cost, margin reporting | 11 |

---

## 14. Top risks

| Risk | Mitigation |
|---|---|
| DISCOM delays push commissioning past the pilot window | Start feasibility applications early (weeks 7–8); measure the pilot on installs; track commissioning as a lagging metric |
| Not yet a registered vendor for the subsidy | Partner as vendor of record initially; register in parallel |
| Supply of DCR / ALMM List-II-compliant modules and price volatility | Price book with validity dates; 2+ suppliers; quote expiry |
| Lender integration is portal-only | Manual mode in the finance workstream from day one; integrate later |
| WhatsApp template rejection or delay | Submit in week 0; SMS/email fallback for critical notifications |
| Regulatory misclassification (LSP) | Week-0 legal opinion; architecture already avoids fund pass-through and holding KYC |
| Small team overload | Scope-cut ladder; concierge mode keeps revenue moving while software lags |

---

## 15. Open questions

Resolved: geography (UP/DVVNL), vendor of record (partner), subsidy recipient (customer), booking and refund terms (§3C proposal), engineering approval (§3D proposal).

Still open:
1. **Which DVVNL-empanelled partner** (founder sourcing). Needed before the first survey.
2. **Billing model:** does the partner or do we invoice the customer? Needs CA/legal input (§3A).
3. **SBI confirmation:** current rates, disbursement recipient and tranches, documents (§3B).
4. **Launch city** within DVVNL territory.
5. Sign-off on the §3C advance and refund figures.

---

### References (regulatory context, verify with counsel before launch)
- PM Surya Ghar national portal and vendor registration: https://solarcalculators.in/blog/pm-surya-ghar-vendor-registration.html
- ALMM List-II in force from June 2026: https://www.mercomindia.com/list-ii-for-solar-cells-into-force-from-june-2026
- RBI Digital Lending Directions 2025 overview: https://www.mondaq.com/india/financial-services/1634276/digital-lending-20-breaking-down-the-rbi-digital-lending-directions-2025
- UP subsidy (central + UPNEDA state top-up, direct transfer to customer): https://greentax.in/solar/uttar-pradesh , https://ncssolar.in/pm-surya-ghar/subsidy-uttar-pradesh
- DVVNL process and timelines (Agra): https://www.solaraiadvisor.com/rooftop-solar-agra.html
- SBI PM Surya Ghar loan: https://bridgewaypower.in/blog/sbi-solar-loan-pm-surya-ghar-yojana-guide , https://myrsolar.com/sbi-pm-surya-ghar-solar-loan
