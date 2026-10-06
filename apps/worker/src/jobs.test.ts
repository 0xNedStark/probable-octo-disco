import { createDb, recordInbound, schema, sql } from '@solar/db';
import { LocalStorage, type SalesAgentResult, type SalesReply } from '@solar/integrations';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchOutbox } from './dispatch';
import { BAD_FILE_REPLY, BILL_RECEIVED_REPLY, jobHandlers, type JobDeps } from './jobs';

const { db, close } = createDb(
  process.env.TEST_DATABASE_URL ?? 'postgres://solar:solar@localhost:5432/solar_test',
);
let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'solar-jobs-'));
});
afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.execute(sql`truncate table messages, ai_actions, outbox, tasks, project_facts, project_events, bill_readings,
    electricity_bills, solar_projects, leads, consents, customers cascade`);
});

const quiet = { async send() {} };
const pdf = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');

function deps(over: Partial<JobDeps> = {}): JobDeps {
  return {
    db,
    storage: new LocalStorage(dir),
    billExtractor: null,
    confidenceThreshold: 0.9,
    media: { download: async () => ({ body: pdf, mimeType: 'application/pdf' }) },
    links: { statusUrl: (id) => `https://x.test/s/${id}`, privacyUrl: 'https://x.test/privacy' },
    log: () => {},
    ...over,
  };
}

const agentSaying = (reply: Partial<SalesReply>): JobDeps['salesAgent'] => ({
  reply: async (): Promise<SalesAgentResult> => ({
    outcome: 'ok',
    reply: {
      intent: 'greeting_or_interest',
      reply: 'Namaste!',
      escalate: false,
      escalation_reason: null,
      ...reply,
    },
    model: 'claude-opus-5-5',
    promptVersion: 'sales-agent-v1',
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 100,
    error: null,
  }),
});

const inbound = (id: string, over: Record<string, unknown> = {}) =>
  recordInbound(db, {
    providerMessageId: id,
    from: '+919123456789',
    profileName: 'Ravi',
    kind: 'text',
    text: 'Solar lagwana hai',
    mediaId: null,
    mimeType: null,
    ...over,
  });

async function run(d: JobDeps) {
  await dispatchOutbox(db, quiet, jobHandlers(d));
  await dispatchOutbox(db, quiet, jobHandlers(d)); // second pass delivers anything the jobs queued
}
const sentReplies = async () =>
  (await db.select().from(schema.messages))
    .filter((m) => m.direction === 'out' && m.kind === 'text')
    .map((m) => m.body);
const taskTitles = async () => (await db.select().from(schema.tasks)).map((t) => t.title);

describe('whatsapp.media', () => {
  it('stores a sent bill, starts extraction and acknowledges', async () => {
    await inbound('w1');
    await inbound('w2', {
      kind: 'document',
      mediaId: 'm1',
      mimeType: 'application/pdf',
      text: null,
    });
    await run(deps());
    const [bill] = await db.select().from(schema.electricityBills);
    expect(bill).toMatchObject({ source: 'whatsapp', contentType: 'application/pdf' });
    const [p] = await db.select().from(schema.solarProjects);
    expect(p?.billState).toBe('RECEIVED');
    expect(await sentReplies()).toContain(BILL_RECEIVED_REPLY);
  });

  it('asks again when the file is not a bill format', async () => {
    await inbound('w3', { kind: 'image', mediaId: 'm2', mimeType: 'image/gif', text: null });
    await run(
      deps({
        media: {
          download: async () => ({
            body: new TextEncoder().encode('GIF89a'),
            mimeType: 'image/gif',
          }),
        },
      }),
    );
    expect(await db.select().from(schema.electricityBills)).toHaveLength(0);
    expect(await sentReplies()).toContain(BAD_FILE_REPLY);
  });
});

describe('sales_agent.reply', () => {
  it('without an agent, hands the message to a person', async () => {
    await inbound('w4');
    await run(deps({ salesAgent: null }));
    expect(await taskTitles()).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Reply on WhatsApp: “Solar lagwana hai”/)]),
    );
    expect(await sentReplies()).toEqual([]);
  });

  it('sends a guarded reply and logs the AI action', async () => {
    await inbound('w5');
    await run(
      deps({
        salesAgent: agentSaying({
          reply: 'Namaste Ravi! Please send a photo of your latest electricity bill.',
        }),
      }),
    );
    expect(await sentReplies()).toEqual([
      'Namaste Ravi! Please send a photo of your latest electricity bill.',
    ]);
    const [a] = await db.select().from(schema.aiActions);
    expect(a).toMatchObject({
      agent: 'sales-agent',
      outcome: 'ok',
      inputRef: { messageId: expect.any(String) },
    });
  });

  it('blocks drafts with invented numbers and hands off with the draft', async () => {
    await inbound('w6', { text: 'Kitne ka padega?' });
    await run(
      deps({
        salesAgent: agentSaying({ intent: 'price_question', reply: 'Around ₹1,50,000 for 3 kW.' }),
      }),
    );
    expect(await sentReplies()).toEqual([]);
    expect(await taskTitles()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Agent draft blocked \(unsupported numbers: 150000, 3\)/),
      ]),
    );
    const ev = (await db.select().from(schema.projectEvents)).find(
      (e) => e.type === 'whatsapp_handoff',
    );
    expect(ev?.payload).toMatchObject({ draft: 'Around ₹1,50,000 for 3 kW.' });
  });

  it('complaints get the acknowledgement and a follow-up task', async () => {
    await inbound('w7', { text: 'Mera solar generate nahi kar raha' });
    await run(
      deps({
        salesAgent: agentSaying({
          intent: 'generation_problem',
          reply: 'Sorry Ravi, our team will call you today.',
          escalate: false,
        }),
      }),
    );
    expect(await sentReplies()).toEqual(['Sorry Ravi, our team will call you today.']);
    expect(await taskTitles()).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Follow up \(generation_problem\)/)]),
    );
  });

  it('answers only the latest of several quick messages', async () => {
    await inbound('w8', { text: 'Hi' });
    await inbound('w9', { text: 'Solar chahiye' });
    let calls = 0;
    await run(
      deps({
        salesAgent: {
          reply: async (...a) => (calls++, agentSaying({ reply: 'Namaste!' })!.reply(...a)),
        },
      }),
    );
    expect(calls).toBe(1);
  });
});
