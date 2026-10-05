import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { outbox, projectEvents, projectFacts, tasks } from './schema';
import { authenticate, createSession, deleteSession, getSessionUser } from './services/auth';
import {
  enterBillReadings,
  openBillForStaff,
  requestBillResubmit,
  type BillReadingInput,
} from './services/bills';
import { ServiceError, SYSTEM } from './services/common';
import { claimOutbox, markFailed, markSent } from './services/outbox';
import { recordFact, transitionStage, transitionWorkstream } from './services/projects';
import { dashboardSummary, getProjectDetail, listProjects } from './services/queries';
import { completeTask, listTasks } from './services/tasks';
import { leadInput, reset, seedLead, staff, testDb } from './test/helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const whatsapp = async () =>
  (await db.select().from(outbox)).filter((m) => m.channel === 'whatsapp');

function reading(billId: string, overrides: Partial<BillReadingInput> = {}): BillReadingInput {
  return {
    billId,
    consumerNumber: '1234567890',
    discom: 'DVVNL',
    tariffCategory: 'LMV-1',
    sanctionedLoadKw: 3,
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    unitsKwh: 420,
    amountRupees: 3150.5,
    monthlyHistory: [{ month: '2026-07', units: 450 }],
    ...overrides,
  };
}

describe('createLead', () => {
  it('creates customer, project, consents, events, tasks and a WhatsApp message', async () => {
    const r = await seedLead(db);
    expect(r.newProject).toBe(true);
    expect(r.projectCode).toMatch(/^SOL-\d{4}-00001$/);

    const d = await getProjectDetail(db, r.projectId);
    expect(d.customer.phone).toBe('+919876543210');
    expect(d.customer.discom).toBe('DVVNL');
    expect(d.project.stage).toBe('LEAD');
    expect(d.project.billState).toBe('RECEIVED');
    expect(d.snapshot.facts.contact_consent).toBe(true);
    expect(d.consents.map((c) => c.purpose).sort()).toEqual([
      'contact',
      'privacy_notice',
      'whatsapp',
    ]);
    expect(d.events.map((e) => e.type).sort()).toEqual(
      ['bill_uploaded', 'fact_recorded', 'lead_created', 'workstream_changed'].sort(),
    );
    expect(d.tasks.map((t) => t.type).sort()).toEqual(['bill_review', 'first_contact']);

    const msgs = await whatsapp();
    expect(msgs).toHaveLength(1);
    const jobs = (await db.select().from(outbox)).filter((m) => m.channel === 'internal');
    expect(jobs).toMatchObject([
      { template: 'bill.extract', payload: { billId: expect.any(String) } },
    ]);
    expect(msgs[0]).toMatchObject({ template: 'lead_received', recipient: '+919876543210' });
  });

  it('sends nothing on WhatsApp without WhatsApp consent', async () => {
    await seedLead(db, {
      consent: { contact: true, whatsapp: false, textVersion: 'v1', channel: 'web' },
    });
    expect(await whatsapp()).toHaveLength(0);
  });

  it('rejects missing consent and bad phone numbers', async () => {
    await expect(
      seedLead(db, {
        consent: { contact: false, whatsapp: false, textVersion: 'v1', channel: 'web' },
      }),
    ).rejects.toThrow(ServiceError);
    await expect(seedLead(db, { phone: '12345' })).rejects.toThrow(/mobile/);
  });

  it('merges a repeat enquiry into the open project', async () => {
    const first = await seedLead(db);
    const second = await seedLead(db, { phone: '+91 9876543210', bill: undefined });
    expect(second.newProject).toBe(false);
    expect(second.projectId).toBe(first.projectId);
    const d = await getProjectDetail(db, first.projectId);
    expect(d.events.some((e) => e.type === 'lead_merged')).toBe(true);
    expect(d.tasks.filter((t) => t.type === 'first_contact')).toHaveLength(1);
  });

  it('starts a new project once the previous one is lost', async () => {
    const ops = await staff(db, 'ops');
    const first = await seedLead(db);
    expect((await transitionStage(db, ops, first.projectId, 'LOST', 'not interested')).ok).toBe(
      true,
    );
    const second = await seedLead(db, { bill: undefined });
    expect(second.newProject).toBe(true);
    expect(second.projectCode).toMatch(/-00002$/);
  });
});

describe('bill readings → QUALIFIED', () => {
  it('manual entry confirms the bill and unlocks QUALIFIED', async () => {
    const ops = await staff(db, 'ops');
    const input = leadInput();
    const { projectId } = await seedLead(db, input);

    const blocked = await transitionStage(db, ops, projectId, 'QUALIFIED');
    expect(blocked.ok).toBe(false);

    const r = await enterBillReadings(db, ops, projectId, reading(input.bill!.id));
    expect(r.ok).toBe(true);

    const moved = await transitionStage(db, ops, projectId, 'QUALIFIED');
    expect(moved).toEqual({ ok: true, from: 'LEAD', to: 'QUALIFIED' });

    const d = await getProjectDetail(db, projectId);
    expect(d.readings[0]).toMatchObject({
      amountPaise: 315050,
      sanctionedLoadW: 3000,
      source: 'manual',
    });
    const billMoves = d.events
      .filter((e) => e.type === 'workstream_changed')
      .map((e) => `${e.fromValue}→${e.toValue}`)
      .reverse();
    expect(billMoves).toEqual([
      'NOT_RECEIVED→RECEIVED',
      'RECEIVED→NEEDS_MANUAL',
      'NEEDS_MANUAL→CONFIRMED',
    ]);
  });

  it('validates readings', async () => {
    const ops = await staff(db, 'ops');
    const input = leadInput();
    const { projectId } = await seedLead(db, input);
    await expect(
      enterBillReadings(
        db,
        ops,
        projectId,
        reading(input.bill!.id, { periodStart: '2026-09-01', unitsKwh: 1.5 }),
      ),
    ).rejects.toThrow(/period start.*whole number/s);
  });

  it('rejects a bill from another project', async () => {
    const ops = await staff(db, 'ops');
    const a = leadInput();
    await seedLead(db, a);
    const b = await seedLead(db, { phone: '9123456789' });
    await expect(enterBillReadings(db, ops, b.projectId, reading(a.bill!.id))).rejects.toThrow(
      /not found/,
    );
  });

  it('engineers cannot enter readings', async () => {
    const eng = await staff(db, 'engineer');
    const input = leadInput();
    const { projectId } = await seedLead(db, input);
    await expect(enterBillReadings(db, eng, projectId, reading(input.bill!.id))).rejects.toThrow(
      /lacks/,
    );
  });

  it('resubmit request creates a follow-up and a customer message', async () => {
    const sales = await staff(db, 'sales');
    const { projectId } = await seedLead(db);
    const r = await requestBillResubmit(db, sales, projectId, 'Photo is blurry');
    expect(r.ok).toBe(true);
    const d = await getProjectDetail(db, projectId);
    expect(d.project.billState).toBe('NEEDS_RESUBMIT');
    expect(d.tasks.some((t) => t.type === 'bill_resubmit_follow_up')).toBe(true);
    const templates = (await whatsapp()).map((m) => m.template).sort();
    expect(templates).toEqual(['bill_resubmit', 'lead_received']);
  });
});

describe('stage transitions with facts (concierge mode)', () => {
  it('walks a project to BOOKED using attested facts and notifies the customer', async () => {
    const ops = await staff(db, 'ops');
    const finance = await staff(db, 'finance');
    const input = leadInput();
    const { projectId } = await seedLead(db, input);
    await enterBillReadings(db, ops, projectId, reading(input.bill!.id));
    expect((await transitionStage(db, ops, projectId, 'QUALIFIED')).ok).toBe(true);

    await recordFact(db, ops, projectId, 'quote_sent', true, 'PDF sent on WhatsApp');
    expect((await transitionStage(db, ops, projectId, 'QUOTED')).ok).toBe(true);

    await recordFact(
      db,
      ops,
      projectId,
      'quote_accepted_indicative',
      true,
      'Customer said yes on call',
    );
    const blocked = await transitionStage(db, ops, projectId, 'BOOKED');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok && blocked.error.code === 'GATE_FAILED') {
      expect(blocked.error.unmet.map((u) => u.fact)).toEqual(['booking_advance']);
    }

    await expect(recordFact(db, ops, projectId, 'booking_advance', true, 'UPI')).rejects.toThrow(
      /cannot record/,
    );
    await recordFact(db, finance, projectId, 'booking_advance', true, 'UPI ref 1234, ₹5,000');
    expect((await transitionStage(db, ops, projectId, 'BOOKED')).ok).toBe(true);

    const templates = (await whatsapp()).map((m) => [m.template, m.payload.stage]);
    expect(templates).toEqual(
      expect.arrayContaining([
        ['stage_changed', 'QUOTED'],
        ['stage_changed', 'BOOKED'],
      ]),
    );
    expect(templates.some(([, s]) => s === 'QUALIFIED')).toBe(false);
  });

  it('a later false fact revokes an earlier true one', async () => {
    const ops = await staff(db, 'ops');
    const { projectId } = await seedLead(db);
    await recordFact(db, ops, projectId, 'quote_sent', true, 'sent');
    await recordFact(db, ops, projectId, 'quote_sent', false, 'sent to wrong number');
    const d = await getProjectDetail(db, projectId);
    expect(d.snapshot.facts.quote_sent).toBe(false);
  });

  it('requires a note for manual facts and a reason for side moves', async () => {
    const ops = await staff(db, 'ops');
    const { projectId } = await seedLead(db);
    await expect(recordFact(db, ops, projectId, 'quote_sent', true, ' ')).rejects.toThrow(/note/);
    const r = await transitionStage(db, ops, projectId, 'ON_HOLD');
    expect(!r.ok && r.error.code).toBe('REASON_REQUIRED');
  });

  it('hold and resume round-trips through held_from_stage', async () => {
    const ops = await staff(db, 'ops');
    const { projectId } = await seedLead(db);
    expect((await transitionStage(db, ops, projectId, 'ON_HOLD', 'customer travelling')).ok).toBe(
      true,
    );
    let d = await getProjectDetail(db, projectId);
    expect(d.project.heldFromStage).toBe('LEAD');
    expect(d.options.map((o) => o.to)).toEqual(['LEAD', 'LOST']);
    expect((await transitionStage(db, ops, projectId, 'LEAD')).ok).toBe(true);
    d = await getProjectDetail(db, projectId);
    expect(d.project).toMatchObject({ stage: 'LEAD', heldFromStage: null });
  });

  it('sales cannot move stages; finance can move workstreams', async () => {
    const sales = await staff(db, 'sales');
    const finance = await staff(db, 'finance');
    const { projectId } = await seedLead(db);
    await expect(transitionStage(db, sales, projectId, 'LOST', 'x')).rejects.toThrow(/lacks/);
    const r = await transitionWorkstream(db, finance, projectId, 'finance', 'DOCS_PENDING');
    expect(r.ok).toBe(true);
    const illegal = await transitionWorkstream(db, finance, projectId, 'finance', 'DISBURSED');
    expect(illegal.ok).toBe(false);
  });

  it('serialises concurrent transitions so only one wins', async () => {
    const ops = await staff(db, 'ops');
    const { projectId } = await seedLead(db);
    const results = await Promise.all([
      transitionStage(db, ops, projectId, 'LOST', 'a'),
      transitionStage(db, ops, projectId, 'LOST', 'b'),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: 'TERMINAL' } });
    const changes = await db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.type, 'stage_changed'));
    expect(changes).toHaveLength(1);
  });
});

describe('audit log', () => {
  it('project_events and project_facts cannot be updated or deleted', async () => {
    await seedLead(db);
    const appendOnly = { cause: { message: expect.stringMatching(/append-only/) } };
    await expect(db.update(projectEvents).set({ reason: 'tampered' })).rejects.toMatchObject(
      appendOnly,
    );
    await expect(db.delete(projectEvents)).rejects.toMatchObject(appendOnly);
    await expect(db.delete(projectFacts)).rejects.toMatchObject(appendOnly);
  });
});

describe('tasks', () => {
  it('completing a task records effort and an event', async () => {
    const sales = await staff(db, 'sales');
    const { projectId } = await seedLead(db);
    const open = await listTasks(db, { projectId });
    const first = open.find((t) => t.task.type === 'first_contact')!;
    await completeTask(db, sales, first.task.id, 7, 'Spoke to customer, sending quote');
    await expect(completeTask(db, sales, first.task.id, 7, 'again')).rejects.toThrow(/not found/);
    await expect(completeTask(db, sales, open[1]!.task.id, -1, '')).rejects.toThrow(/Effort/);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, first.task.id));
    expect(row).toMatchObject({ status: 'DONE', effortMinutes: 7, completedBy: sales.id });
    const d = await getProjectDetail(db, projectId);
    expect(d.events.some((e) => e.type === 'task_completed')).toBe(true);
  });
});

describe('queries', () => {
  it('lists projects with task counts and searches by name/phone/code', async () => {
    const a = await seedLead(db);
    await seedLead(db, {
      name: 'Ravi Kumar',
      phone: '9123456789',
      city: 'Mathura',
      bill: undefined,
    });
    await db.execute(
      sql`update tasks set due_at = now() - interval '1 hour' where project_id = ${a.projectId}`,
    );

    const all = await listProjects(db);
    expect(all).toHaveLength(2);
    const asha = all.find((p) => p.id === a.projectId)!;
    expect(asha).toMatchObject({ openTasks: 2, overdueTasks: 2, customerName: 'Asha Verma' });

    expect((await listProjects(db, { q: 'ravi' })).map((p) => p.city)).toEqual(['Mathura']);
    expect(await listProjects(db, { q: '91234' })).toHaveLength(1);
    expect(await listProjects(db, { q: a.projectCode })).toHaveLength(1);
    expect(await listProjects(db, { q: '%' })).toHaveLength(0);
    expect(await listProjects(db, { stage: 'QUOTED' })).toHaveLength(0);
  });

  it('dashboard counts today’s leads, overdue tasks and stages', async () => {
    await seedLead(db);
    const s = await dashboardSummary(db);
    expect(s).toMatchObject({ leadsToday: 1, overdueTasks: 0, byStage: { LEAD: 1 } });
    const later = await dashboardSummary(db, new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect(later.overdueTasks).toBe(2);
    // A lead from yesterday (IST) doesn't count as today.
    const tomorrow = await dashboardSummary(db, new Date(Date.now() + 26 * 60 * 60 * 1000));
    expect(tomorrow.leadsToday).toBe(0);
  });
});

describe('auth', () => {
  it('authenticates, locks after repeated failures, and manages sessions', async () => {
    const admin = await staff(db, 'admin');
    const [u] = await db.execute<{ email: string }>(
      sql`select email from users where id = ${admin.id}`,
    );
    const email = u!.email;

    expect(await authenticate(db, email, 'wrong')).toBeNull();
    const ok = await authenticate(db, email.toUpperCase(), 'correct horse battery');
    expect(ok?.role).toBe('admin');
    expect(await authenticate(db, 'nobody@example.com', 'x')).toBeNull();

    for (let i = 0; i < 5; i++) await authenticate(db, email, 'wrong');
    expect(await authenticate(db, email, 'correct horse battery')).toBeNull(); // locked

    const { token } = await createSession(db, admin.id);
    expect((await getSessionUser(db, token))?.id).toBe(admin.id);
    expect(await getSessionUser(db, 'not-a-token')).toBeNull();
    await deleteSession(db, token);
    expect(await getSessionUser(db, token)).toBeNull();
  });
});

describe('files', () => {
  it('logs every staff bill access', async () => {
    const ops = await staff(db, 'ops');
    const input = leadInput();
    await seedLead(db, input);
    const bill = await openBillForStaff(db, ops, input.bill!.id);
    expect(bill.storageKey).toBe('bills/test.pdf');
    const [log] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from file_access_log`,
    );
    expect(log!.n).toBe(1);
    await expect(openBillForStaff(db, SYSTEM, input.bill!.id)).rejects.toThrow(/staff/);
  });
});

describe('outbox', () => {
  it('claims each message once, retries with backoff, and marks sent', async () => {
    await seedLead(db, { bill: undefined });
    await seedLead(db, { phone: '9123456789', bill: undefined });
    const [a, b] = await Promise.all([claimOutbox(db, 1), claimOutbox(db, 1)]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.id).not.toBe(b[0]!.id);
    expect(await claimOutbox(db)).toHaveLength(0);

    await markSent(db, a[0]!.id);
    await markFailed(db, b[0]!, 'BSP timeout');
    const rows = await db.select().from(outbox);
    const failed = rows.find((r) => r.id === b[0]!.id)!;
    expect(failed).toMatchObject({ status: 'pending', attempts: 1, lastError: 'BSP timeout' });
    expect(failed.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(rows.find((r) => r.id === a[0]!.id)?.status).toBe('sent');
    expect(await claimOutbox(db)).toHaveLength(0); // not yet due
  });
});
