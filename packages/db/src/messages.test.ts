import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { consents, customers, messages, outbox } from './schema';
import {
  customerFacts,
  queueReply,
  recordInbound,
  recordOutbound,
  sendStaffReply,
  SESSION_WINDOW_MS,
} from './services/messages';
import { getProjectDetail } from './services/queries';
import { reset, seedLead, staff, testDb } from './test/helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const inbound = (id: string, overrides: Partial<Parameters<typeof recordInbound>[1]> = {}) => ({
  providerMessageId: id,
  from: '+919123456789',
  profileName: 'Ravi Kumar',
  kind: 'text' as const,
  text: 'Solar lagwana hai',
  mediaId: null,
  mimeType: null,
  ...overrides,
});
const jobs = async () =>
  (await db.select().from(outbox)).filter((o) => o.channel === 'internal').map((o) => o.template);

describe('recordInbound', () => {
  it('turns an unknown number into a WhatsApp lead and queues the Sales Agent', async () => {
    const r = await recordInbound(db, inbound('wamid.1'));
    expect(r.duplicate).toBe(false);
    expect(r.projectId).toMatch(/^prj_/);
    const d = await getProjectDetail(db, r.projectId!);
    expect(d.customer).toMatchObject({
      name: 'Ravi Kumar',
      city: 'Unknown',
      phone: '+919123456789',
    });
    expect(d.lead?.source).toBe('whatsapp');
    expect(d.consents.map((c) => c.textVersion)).toContain('whatsapp-inbound-v1');
    expect(await jobs()).toEqual(['sales_agent.reply']);
  });

  it('is idempotent on provider message id', async () => {
    const a = await recordInbound(db, inbound('wamid.1'));
    const b = await recordInbound(db, inbound('wamid.1'));
    expect(b).toMatchObject({ duplicate: true, messageId: a.messageId });
    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it('routes media to bill intake for existing customers', async () => {
    const { projectId } = await seedLead(db, { phone: '9123456789', bill: undefined });
    const r = await recordInbound(
      db,
      inbound('wamid.2', { kind: 'image', mediaId: 'm1', mimeType: 'image/jpeg', text: null }),
    );
    expect(r.projectId).toBe(projectId);
    expect(await jobs()).toEqual(['whatsapp.media']);
  });

  it('STOP withdraws WhatsApp consent and queues nothing', async () => {
    await seedLead(db, { phone: '9123456789', bill: undefined });
    const r = await recordInbound(db, inbound('wamid.3', { text: 'STOP' }));
    expect(r.optedOut).toBe(true);
    const [c] = await db.select().from(customers).where(eq(customers.phone, '+919123456789'));
    const wa = await db.select().from(consents).where(eq(consents.customerId, c!.id));
    expect(wa.find((x) => x.purpose === 'whatsapp')?.withdrawnAt).toBeInstanceOf(Date);
    expect(await jobs()).toEqual([]);
  });

  it('STOP from an unknown number creates nothing', async () => {
    await recordInbound(db, inbound('wamid.4', { text: 'stop' }));
    expect(await db.select().from(customers)).toHaveLength(0);
  });
});

describe('replies', () => {
  it('free-form replies only inside the 24h window', async () => {
    const { projectId } = await seedLead(db, { phone: '9123456789', bill: undefined });
    await expect(queueReply(db, { kind: 'staff', id: 'u' }, projectId, 'hi')).rejects.toThrow(
      /24-hour/,
    );
    await recordInbound(db, inbound('wamid.5'));
    const sales = await staff(db, 'sales');
    await sendStaffReply(db, sales, projectId, 'Namaste! Please share your bill.');
    const reply = (await db.select().from(outbox)).find((o) => o.template === 'reply');
    expect(reply?.payload).toMatchObject({
      text: 'Namaste! Please share your bill.',
      author: 'staff',
      authorId: sales.id,
    });
    await db.update(messages).set({ createdAt: new Date(Date.now() - SESSION_WINDOW_MS - 1000) });
    await expect(sendStaffReply(db, sales, projectId, 'late')).rejects.toThrow(/24-hour/);
    await expect(sendStaffReply(db, await staff(db, 'engineer'), projectId, 'x')).rejects.toThrow(
      /lacks/,
    );
  });

  it('records outbound messages for the conversation log', async () => {
    const { projectId } = await seedLead(db, { phone: '9123456789', bill: undefined });
    await recordOutbound(db, {
      outboxId: 'obx_1',
      projectId,
      phone: '+919123456789',
      template: 'reply',
      rendered: 'hello',
      providerMessageId: 'wamid.out',
      author: 'agent',
      authorId: 'sales-agent',
    });
    const [m] = await db.select().from(messages);
    expect(m).toMatchObject({ direction: 'out', kind: 'text', body: 'hello', author: 'agent' });
  });
});

describe('customerFacts', () => {
  it('contains only customer-safe facts', async () => {
    const { projectId } = await seedLead(db, { phone: '9123456789' });
    const f = await customerFacts(db, projectId, {
      statusUrl: 'https://x/s/t',
      privacyUrl: 'https://x/privacy',
    });
    expect(f).toMatchObject({
      customerFirstName: 'Asha',
      billReceived: true,
      proposal: null,
      paymentsReceivedRupees: 0,
      statusPageUrl: 'https://x/s/t',
    });
    expect(f.status.title).toBe('Enquiry received');
    expect(JSON.stringify(f)).not.toMatch(/\+91|cus_|usr_/);
  });
});
