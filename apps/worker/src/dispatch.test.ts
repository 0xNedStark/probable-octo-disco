import { createDb, createLead, schema, sql } from '@solar/db';
import type { ExtractionResult, Notifier, OutboundMessage } from '@solar/integrations';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorage } from '@solar/integrations';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { dispatchOutbox } from './dispatch';
import { jobHandlers } from './jobs';

const { db, close } = createDb(
  process.env.TEST_DATABASE_URL ?? 'postgres://solar:solar@localhost:5432/solar_test',
);
let dir = '';
afterAll(async () => {
  await close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.execute(sql`truncate table ai_actions, outbox, tasks, project_facts, project_events, bill_readings,
    electricity_bills, solar_projects, leads, consents, customers cascade`);
});

const lead = (phone: string, bill?: { id: string; storageKey: string }) =>
  createLead(db, {
    name: 'Asha',
    phone,
    city: 'Agra',
    source: 'web',
    consent: { contact: true, whatsapp: true, textVersion: 'v1', channel: 'web' },
    bill: bill && {
      ...bill,
      originalFilename: 'b.pdf',
      contentType: 'application/pdf',
      sizeBytes: 8,
      sha256: 'x',
    },
  });

const quietLog = () => {};

it('sends due messages and retries failures', async () => {
  await lead('9876543210');
  await lead('9123456789');
  const sent: OutboundMessage[] = [];
  const flaky: Notifier = {
    async send(m) {
      if (m.recipient === '+919123456789') throw new Error('BSP 503');
      sent.push(m);
    },
  };
  expect(await dispatchOutbox(db, flaky)).toBe(2);
  expect(sent.map((m) => m.template)).toEqual(['lead_received']);
  const rows = await db.select().from(schema.outbox);
  expect(rows.map((r) => r.status).sort()).toEqual(['pending', 'sent']);
  expect(rows.find((r) => r.status === 'pending')?.lastError).toBe('BSP 503');
  expect(await dispatchOutbox(db, flaky)).toBe(0); // failed one is backing off
});

it('runs bill extraction jobs through the Bill Agent and records the outcome', async () => {
  dir = await mkdtemp(join(tmpdir(), 'solar-worker-'));
  const storage = new LocalStorage(dir);
  await storage.put('bills/a.pdf', new TextEncoder().encode('%PDF-1.4'), 'application/pdf');
  const { projectId } = await lead('9876543210', { id: 'bil_TEST1', storageKey: 'bills/a.pdf' });

  const result: ExtractionResult = {
    outcome: 'ok',
    model: 'claude-opus-5-5',
    promptVersion: 'bill-extract-v1',
    inputTokens: 1000,
    outputTokens: 200,
    latencyMs: 1234,
    error: null,
    extraction: {
      isElectricityBill: true,
      notes: null,
      fields: {
        consumerNumber: '1234567890',
        discom: 'DVVNL',
        tariffCategory: 'LMV-1',
        sanctionedLoadKw: 3,
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        unitsKwh: 420,
        amountRupees: 3150,
        monthlyHistory: [],
      },
      confidence: {
        consumerNumber: 0.99,
        discom: 0.99,
        tariffCategory: 0.99,
        sanctionedLoadKw: 0.99,
        periodStart: 0.99,
        periodEnd: 0.99,
        unitsKwh: 0.99,
        amountRupees: 0.99,
      },
    },
  };
  const seen: number[] = [];
  const jobs = jobHandlers({
    db,
    storage,
    billExtractor: { extract: async (body) => (seen.push(body.byteLength), result) },
    confidenceThreshold: 0.9,
    log: quietLog,
  });
  const quiet: Notifier = { async send() {} };
  await dispatchOutbox(db, quiet, jobs);

  expect(seen).toEqual([8]);
  const [p] = await db.select().from(schema.solarProjects);
  expect(p?.billState).toBe('EXTRACTED');
  const [action] = await db.select().from(schema.aiActions);
  expect(action).toMatchObject({
    projectId,
    agent: 'bill-agent',
    outcome: 'ok',
    inputRef: { billId: 'bil_TEST1', sha256: 'x' },
  });
  const statuses = (await db.select().from(schema.outbox)).map((r) => [r.template, r.status]);
  expect(statuses).toEqual(expect.arrayContaining([['bill.extract', 'sent']]));
});

it('with AI off, extraction jobs complete without touching the bill', async () => {
  await lead('9876543210', { id: 'bil_TEST2', storageKey: 'bills/none.pdf' });
  const jobs = jobHandlers({
    db,
    storage: new LocalStorage(tmpdir()),
    billExtractor: null,
    confidenceThreshold: 0.9,
    log: quietLog,
  });
  await dispatchOutbox(db, { async send() {} }, jobs);
  const [p] = await db.select().from(schema.solarProjects);
  expect(p?.billState).toBe('RECEIVED');
  expect((await db.select().from(schema.outbox)).every((r) => r.status === 'sent')).toBe(true);
});

it('unknown jobs fail and are retried later', async () => {
  await db.insert(schema.outbox).values({
    id: 'obx_x',
    channel: 'internal',
    template: 'nope',
    recipient: 'worker',
    payload: {},
  });
  await dispatchOutbox(db, { async send() {} }, {});
  const [row] = await db.select().from(schema.outbox);
  expect(row).toMatchObject({ status: 'pending', lastError: 'No handler for job nope' });
});
