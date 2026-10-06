import type {
  ActorType,
  Fact,
  MainStage,
  Role,
  Stage,
  TaskStatus,
  TaskType,
  WorkstreamState,
} from '@solar/domain';
import type { CalcInput, CalcOutput, ConfigKind } from '@solar/calc';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const projectCodeSeq = pgSequence('project_code_seq', { startWith: 1 });

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  role: text('role').$type<Role>().notNull(),
  passwordHash: text('password_hash').notNull(),
  active: boolean('active').notNull().default(true),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: ts('locked_until'),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the cookie token; the raw token is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const customers = pgTable('customers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** E.164, e.g. +919876543210 */
  phone: text('phone').notNull().unique(),
  city: text('city').notNull(),
  pincode: text('pincode'),
  discom: text('discom'),
  consumerNumber: text('consumer_number'),
  preferredLanguage: text('preferred_language').notNull().default('hi'),
  createdAt: createdAt(),
});

export const consents = pgTable(
  'consents',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    /** contact | whatsapp | privacy_notice */
    purpose: text('purpose').notNull(),
    /** Version of the consent / notice text the customer saw. */
    textVersion: text('text_version').notNull(),
    channel: text('channel').notNull(),
    grantedAt: ts('granted_at').notNull().defaultNow(),
    withdrawnAt: ts('withdrawn_at'),
  },
  (t) => [index('consents_customer_idx').on(t.customerId)],
);

export const leads = pgTable('leads', {
  id: text('id').primaryKey(),
  customerId: text('customer_id')
    .notNull()
    .references(() => customers.id),
  source: text('source').notNull(),
  campaign: text('campaign'),
  referrer: text('referrer'),
  /** Customer's own estimate of their monthly bill, in paise. */
  statedMonthlyBillPaise: bigint('stated_monthly_bill_paise', { mode: 'number' }),
  createdAt: createdAt(),
});

export const solarProjects = pgTable(
  'solar_projects',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull().unique(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    leadId: text('lead_id').references(() => leads.id),
    stage: text('stage').$type<Stage>().notNull(),
    heldFromStage: text('held_from_stage').$type<MainStage>(),
    billState: text('bill_state').$type<WorkstreamState<'bill'>>().notNull(),
    financeState: text('finance_state').$type<WorkstreamState<'finance'>>().notNull(),
    regulatoryState: text('regulatory_state').$type<WorkstreamState<'regulatory'>>().notNull(),
    procurementState: text('procurement_state').$type<WorkstreamState<'procurement'>>().notNull(),
    installationState: text('installation_state')
      .$type<WorkstreamState<'installation'>>()
      .notNull(),
    /** DVVNL-empanelled partner holding the portal vendor role (PLAN §3A). */
    vendorOfRecordId: text('vendor_of_record_id'),
    /** 'partner' | 'company' — who invoices the customer (PLAN §3A, pending CA advice). */
    billingEntity: text('billing_entity'),
    ownerUserId: text('owner_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('projects_stage_idx').on(t.stage), index('projects_customer_idx').on(t.customerId)],
);

export const electricityBills = pgTable(
  'electricity_bills',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => solarProjects.id),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    storageKey: text('storage_key').notNull(),
    originalFilename: text('original_filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    /** web | whatsapp | ops */
    source: text('source').notNull(),
    uploadedBy: text('uploaded_by').references(() => users.id),
    uploadedAt: ts('uploaded_at').notNull().defaultNow(),
  },
  (t) => [index('bills_project_idx').on(t.projectId), index('bills_sha_idx').on(t.sha256)],
);

export interface MonthlyUsage {
  /** YYYY-MM */
  month: string;
  units: number;
}

export const billReadings = pgTable(
  'bill_readings',
  {
    id: text('id').primaryKey(),
    billId: text('bill_id')
      .notNull()
      .references(() => electricityBills.id),
    projectId: text('project_id')
      .notNull()
      .references(() => solarProjects.id),
    consumerNumber: text('consumer_number').notNull(),
    discom: text('discom').notNull(),
    tariffCategory: text('tariff_category').notNull(),
    sanctionedLoadW: integer('sanctioned_load_w').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    unitsKwh: integer('units_kwh').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    monthlyHistory: jsonb('monthly_history').$type<MonthlyUsage[]>().notNull().default([]),
    /** manual | ai */
    source: text('source').notNull(),
    /** Per-field model confidence when source = ai. */
    confidence: jsonb('confidence').$type<Record<string, number>>(),
    /** proposed (AI, awaiting human confirmation) | confirmed | rejected */
    status: text('status')
      .$type<'proposed' | 'confirmed' | 'rejected'>()
      .notNull()
      .default('confirmed'),
    enteredBy: text('entered_by').references(() => users.id),
    confirmedBy: text('confirmed_by').references(() => users.id),
    confirmedAt: ts('confirmed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('readings_project_idx').on(t.projectId)],
);

/** Append-only audit log; UPDATE/DELETE are blocked by a trigger (migration 0001). */
export const projectEvents = pgTable(
  'project_events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => solarProjects.id),
    type: text('type').notNull(),
    actorType: text('actor_type').$type<ActorType>().notNull(),
    actorId: text('actor_id').notNull(),
    fromValue: text('from_value'),
    toValue: text('to_value'),
    reason: text('reason'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('events_project_idx').on(t.projectId, t.createdAt)],
);

/** Each row records a fact; the latest row per (project, fact) is current. */
export const projectFacts = pgTable(
  'project_facts',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => solarProjects.id),
    fact: text('fact').$type<Fact>().notNull(),
    value: boolean('value').notNull(),
    /** manual | system */
    source: text('source').notNull(),
    note: text('note'),
    actorType: text('actor_type').$type<ActorType>().notNull(),
    actorId: text('actor_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('facts_project_idx').on(t.projectId, t.fact, t.createdAt)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => solarProjects.id),
    type: text('type').$type<TaskType>().notNull(),
    title: text('title').notNull(),
    status: text('status').$type<TaskStatus>().notNull().default('OPEN'),
    role: text('role').$type<Role>().notNull(),
    assigneeUserId: text('assignee_user_id').references(() => users.id),
    dueAt: ts('due_at').notNull(),
    completedAt: ts('completed_at'),
    completedBy: text('completed_by').references(() => users.id),
    effortMinutes: integer('effort_minutes'),
    outcome: text('outcome'),
    createdAt: createdAt(),
  },
  (t) => [
    index('tasks_open_idx')
      .on(t.dueAt)
      .where(sql`${t.status} = 'OPEN'`),
    index('tasks_project_idx').on(t.projectId),
  ],
);

/** Transactional outbox: every outbound side effect is written here in the same transaction. */
export const outbox = pgTable(
  'outbox',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => solarProjects.id),
    channel: text('channel').notNull(),
    template: text('template').notNull(),
    recipient: text('recipient').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** pending | processing | sent | failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: ts('available_at').notNull().defaultNow(),
    lockedAt: ts('locked_at'),
    lastError: text('last_error'),
    sentAt: ts('sent_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('outbox_pending_idx')
      .on(t.availableAt)
      .where(sql`${t.status} in ('pending', 'processing')`),
  ],
);

/** Every staff read of a personal document is logged (PLAN §6 Files). */
export const fileAccessLog = pgTable('file_access_log', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  billId: text('bill_id')
    .notNull()
    .references(() => electricityBills.id),
  projectId: text('project_id')
    .notNull()
    .references(() => solarProjects.id),
  accessedAt: ts('accessed_at').notNull().defaultNow(),
});

/** Immutable, versioned configuration documents (tariff, subsidy, price book, lenders, site). */
export const configVersions = pgTable(
  'config_versions',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<ConfigKind>().notNull(),
    version: integer('version').notNull(),
    body: jsonb('body').$type<Record<string, unknown>>().notNull(),
    /** sha256 of the canonical body. */
    bodyHash: text('body_hash').notNull(),
    note: text('note').notNull(),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('config_kind_version_idx').on(t.kind, t.version)],
);

export type QuoteGrade = 'INDICATIVE' | 'FINAL';
export type QuoteStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'SUPERSEDED';

export const solarQuotes = pgTable(
  'solar_quotes',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => solarProjects.id),
    /** 1, 2, 3… per project. */
    version: integer('version').notNull(),
    grade: text('grade').$type<QuoteGrade>().notNull(),
    status: text('status').$type<QuoteStatus>().notNull().default('DRAFT'),
    calcVersion: text('calc_version').notNull(),
    /** config_versions ids used, by kind. */
    configVersionIds: jsonb('config_version_ids').$type<Record<ConfigKind, string>>().notNull(),
    configHash: text('config_hash').notNull(),
    input: jsonb('input').$type<CalcInput>().notNull(),
    output: jsonb('output').$type<CalcOutput>().notNull(),
    /** sha256 of the canonical output, to prove reproduction. */
    outputHash: text('output_hash').notNull(),
    systemKw: text('system_kw').notNull(),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
    /** sha256 of the customer share token; the raw token only appears in the link. */
    shareTokenHash: text('share_token_hash').unique(),
    validUntil: date('valid_until').notNull(),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
    sentAt: ts('sent_at'),
    acceptedAt: ts('accepted_at'),
  },
  (t) => [uniqueIndex('quotes_project_version_idx').on(t.projectId, t.version)],
);

/** Every model call is logged (PLAN §8 guardrails). */
export const aiActions = pgTable(
  'ai_actions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => solarProjects.id),
    agent: text('agent').notNull(),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    /** What the call was about, e.g. { billId }. Never raw document content. */
    inputRef: jsonb('input_ref').$type<Record<string, unknown>>().notNull(),
    output: jsonb('output').$type<Record<string, unknown>>(),
    /** ok | refused | invalid_output | error */
    outcome: text('outcome').notNull(),
    error: text('error'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    createdAt: createdAt(),
  },
  (t) => [index('ai_actions_project_idx').on(t.projectId)],
);

export type PaymentStatus = 'CREATED' | 'PAID' | 'FAILED' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';

export const payments = pgTable(
  'payments',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => solarProjects.id),
    /** booking_advance | milestone | other */
    purpose: text('purpose').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    status: text('status').$type<PaymentStatus>().notNull().default('CREATED'),
    /** razorpay | dev | manual */
    provider: text('provider').notNull(),
    /** Payment link id at the provider. */
    providerRef: text('provider_ref').unique(),
    providerPaymentId: text('provider_payment_id').unique(),
    payUrl: text('pay_url'),
    /** UPI/NEFT reference for manual payments. */
    reference: text('reference'),
    /** config_versions id of the commercial terms in force. */
    commercialConfigId: text('commercial_config_id'),
    quoteId: text('quote_id').references(() => solarQuotes.id),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
    paidAt: ts('paid_at'),
    refundedAt: ts('refunded_at'),
  },
  (t) => [index('payments_project_idx').on(t.projectId)],
);

/** Double-entry-lite money movements; append-only (migration). */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => solarProjects.id),
    paymentId: text('payment_id').references(() => payments.id),
    debitAccount: text('debit_account').notNull(),
    creditAccount: text('credit_account').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    memo: text('memo').notNull(),
    actorType: text('actor_type').$type<ActorType>().notNull(),
    actorId: text('actor_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ledger_project_idx').on(t.projectId)],
);

/** Inbound webhooks, stored before processing; (provider, event_id) makes delivery idempotent. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
    processedAt: ts('processed_at'),
    error: text('error'),
  },
  (t) => [uniqueIndex('webhook_provider_event_idx').on(t.provider, t.eventId)],
);

export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: text('id').primaryKey(),
    /** e.g. quote_accept */
    purpose: text('purpose').notNull(),
    /** What is being authorised, e.g. a quote id. */
    subjectId: text('subject_id').notNull(),
    phone: text('phone').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('otp_subject_idx').on(t.purpose, t.subjectId, t.createdAt)],
);

export type LoanStatus =
  'DOCS_PENDING' | 'SUBMITTED' | 'SANCTIONED' | 'REJECTED' | 'DISBURSED' | 'WITHDRAWN';

/** The customer applies to the bank; we track status. No KYC documents are stored (PLAN §3B). */
export const loanApplications = pgTable(
  'loan_applications',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => solarProjects.id),
    lender: text('lender').notNull(),
    productId: text('product_id').notNull(),
    requestedPaise: bigint('requested_paise', { mode: 'number' }).notNull(),
    status: text('status').$type<LoanStatus>().notNull().default('DOCS_PENDING'),
    /** Bank / JanSamarth application reference. */
    externalRef: text('external_ref'),
    sanctionedPaise: bigint('sanctioned_paise', { mode: 'number' }),
    disbursedPaise: bigint('disbursed_paise', { mode: 'number' }),
    /** Which checklist items the customer has ready (ticked by staff). */
    checklist: jsonb('checklist').$type<Record<string, boolean>>().notNull().default({}),
    note: text('note'),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('loans_project_idx').on(t.projectId)],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => solarProjects.id),
    customerId: text('customer_id').references(() => customers.id),
    channel: text('channel').notNull(),
    direction: text('direction').$type<'in' | 'out'>().notNull(),
    /** Provider message id; unique so webhook retries don't duplicate. */
    providerMessageId: text('provider_message_id').unique(),
    phone: text('phone').notNull(),
    /** text | image | document | template | other */
    kind: text('kind').notNull(),
    body: text('body'),
    mediaId: text('media_id'),
    mediaMimeType: text('media_mime_type'),
    /** For outbound: customer | agent | staff | system */
    author: text('author'),
    authorId: text('author_id'),
    outboxId: text('outbox_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('messages_phone_idx').on(t.phone, t.createdAt),
    index('messages_project_idx').on(t.projectId, t.createdAt),
  ],
);
