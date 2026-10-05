import { createDb, createLead, schema, sql } from '@solar/db';
import type { Notifier, OutboundMessage } from '@solar/integrations';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { dispatchOutbox } from './dispatch';

const { db, close } = createDb(
  process.env.TEST_DATABASE_URL ?? 'postgres://solar:solar@localhost:5432/solar_test',
);
afterAll(close);
beforeEach(async () => {
  await db.execute(sql`truncate table outbox, tasks, project_facts, project_events, electricity_bills,
    solar_projects, leads, consents, customers cascade`);
});

const lead = (phone: string) =>
  createLead(db, {
    name: 'Asha',
    phone,
    city: 'Agra',
    source: 'web',
    consent: { contact: true, whatsapp: true, textVersion: 'v1', channel: 'web' },
  });

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
