import { UP_DVVNL_SEED } from '@solar/calc';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { billReadings, configVersions, outbox, solarQuotes } from './schema';
import {
  enterBillReadings,
  recordBillExtraction,
  type BillExtraction,
  type BillReadingInput,
} from './services/bills';
import { activeConfig, publishConfig, seedConfig } from './services/config';
import { logAiAction } from './services/ai';
import { transitionStage } from './services/projects';
import { getProjectDetail } from './services/queries';
import {
  acceptQuote,
  generateQuote,
  getQuoteByToken,
  listQuotes,
  reproduceQuote,
  sendBlockers,
  sendQuote,
} from './services/quotes';
import { leadInput, reset, seedLead, staff, testDb } from './test/helpers';

const { db, close } = testDb();
afterAll(close);

/** A real (non-placeholder) price book so quotes can be sent. */
const REAL_PRICES = { ...UP_DVVNL_SEED.pricebook, placeholder: false };

beforeEach(() => reset(db));

function reading(billId: string, overrides: Partial<BillReadingInput> = {}): BillReadingInput {
  return {
    billId,
    consumerNumber: '1234567890',
    discom: 'DVVNL',
    tariffCategory: 'LMV-1-URBAN',
    sanctionedLoadKw: 5,
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    unitsKwh: 420,
    amountRupees: 3150,
    monthlyHistory: [
      { month: '2026-07', units: 450 },
      { month: '2026-06', units: 520 },
    ],
    ...overrides,
  };
}

async function qualifiedProject() {
  const ops = await staff(db, 'ops');
  const input = leadInput();
  const { projectId } = await seedLead(db, input);
  await enterBillReadings(db, ops, projectId, reading(input.bill!.id));
  return { ops, projectId, billId: input.bill!.id };
}

async function withRealPrices<T>(fn: () => Promise<T>): Promise<T> {
  const admin = await staff(db, 'admin');
  await publishConfig(db, admin, 'pricebook', REAL_PRICES, 'test: real prices');
  return fn();
}

describe('config', () => {
  it('seeds once, validates and versions publications', async () => {
    expect(await seedConfig(db)).toEqual([]);
    const admin = await staff(db, 'admin');
    const ops = await staff(db, 'ops');
    const before = await activeConfig(db);

    await expect(publishConfig(db, ops, 'tariff', UP_DVVNL_SEED.tariff, 'x')).rejects.toThrow(
      /lacks/,
    );
    await expect(
      publishConfig(db, admin, 'tariff', { defaultCategory: 'X' }, 'bad'),
    ).rejects.toThrow(/Invalid tariff config/);
    await expect(publishConfig(db, admin, 'tariff', UP_DVVNL_SEED.tariff, ' ')).rejects.toThrow(
      /Describe/,
    );

    const r = await publishConfig(
      db,
      admin,
      'site',
      { ...UP_DVVNL_SEED.site, targetOffset: 0.9 },
      'cover 90%',
    );
    const after = await activeConfig(db);
    expect(after.labels.site).toBe(`site@${r.version}`);
    expect(r.version).toBe(Number(before.labels.site.split('@')[1]) + 1);
    expect(after.hash).not.toBe(before.hash);
  });

  it('published config cannot be edited or deleted', async () => {
    const appendOnly = { cause: { message: expect.stringMatching(/append-only/) } };
    await expect(db.update(configVersions).set({ note: 'tampered' })).rejects.toMatchObject(
      appendOnly,
    );
    await expect(db.delete(configVersions)).rejects.toMatchObject(appendOnly);
  });
});

describe('quotes', () => {
  it('requires a confirmed reading', async () => {
    const ops = await staff(db, 'ops');
    const { projectId } = await seedLead(db);
    await expect(generateQuote(db, ops, projectId, { grade: 'INDICATIVE' })).rejects.toThrow(
      /Confirm the bill/,
    );
  });

  it('generates a reproducible, versioned quote from the confirmed bill', async () => {
    const { ops, projectId } = await qualifiedProject();
    const q = await generateQuote(db, ops, projectId, { grade: 'INDICATIVE' });
    expect(q).toMatchObject({
      version: 1,
      status: 'DRAFT',
      grade: 'INDICATIVE',
      calcVersion: '1.0.0',
    });
    expect(q.input.monthlyUsage).toEqual([
      { month: '2026-07', units: 450 },
      { month: '2026-06', units: 520 },
      { month: '2026-08', units: 420 },
    ]);
    expect(q.input).toMatchObject({
      city: 'Agra',
      sanctionedLoadKw: 5,
      tariffCategory: 'LMV-1-URBAN',
    });
    expect(q.output.flags).toContain('placeholder_prices');
    expect(await reproduceQuote(db, q.id)).toEqual({
      reproducible: true,
      matches: true,
      reason: null,
    });

    // Publishing new config later doesn't change how the old quote reproduces.
    const admin = await staff(db, 'admin');
    await publishConfig(
      db,
      admin,
      'site',
      { ...UP_DVVNL_SEED.site, specificYield: { defaultKwhPerKwp: 1300, byCity: {} } },
      'lower yield',
    );
    expect((await reproduceQuote(db, q.id)).matches).toBe(true);
    const q2 = await generateQuote(db, ops, projectId, { grade: 'INDICATIVE' });
    expect(q2.version).toBe(2);
    expect(q2.configHash).not.toBe(q.configHash);
    const all = await listQuotes(db, projectId);
    expect(all.map((x) => [x.version, x.status])).toEqual([
      [2, 'DRAFT'],
      [1, 'SUPERSEDED'],
    ]);
  });

  it('stored calculations are immutable', async () => {
    const { ops, projectId } = await qualifiedProject();
    const q = await generateQuote(db, ops, projectId, { grade: 'INDICATIVE' });
    await expect(
      db.update(solarQuotes).set({ totalPaise: 1 }).where(eq(solarQuotes.id, q.id)),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/immutable/) },
    });
    await expect(db.delete(solarQuotes)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/append-only/) },
    });
  });

  it('refuses to send a quote priced from a placeholder price book', async () => {
    const { ops, projectId } = await qualifiedProject();
    await publishConfig(
      db,
      await staff(db, 'admin'),
      'pricebook',
      UP_DVVNL_SEED.pricebook,
      'test: placeholder',
    );
    const q = await generateQuote(db, ops, projectId, { grade: 'INDICATIVE' });
    expect(sendBlockers(q)).toEqual([expect.stringMatching(/placeholder/)]);
    await expect(sendQuote(db, ops, q.id, 'https://example.test')).rejects.toThrow(/placeholder/);
  });

  it('send → view → accept walks the project to BOOKED-ready', async () => {
    const { ops, projectId } = await qualifiedProject();
    const q = await withRealPrices(() =>
      generateQuote(db, ops, projectId, { grade: 'INDICATIVE' }),
    );
    expect(q.output.flags).not.toContain('placeholder_prices');

    const { token, url } = await sendQuote(db, ops, q.id, 'https://example.test/');
    expect(url).toBe(`https://example.test/p/${token}`);
    await expect(sendQuote(db, ops, q.id, 'https://example.test')).rejects.toThrow(/sent/);

    const msg = (await db.select().from(outbox)).find((m) => m.template === 'quote_sent');
    expect(msg?.payload).toMatchObject({ url, systemKw: q.output.system.kw });

    // QUOTED is now reachable via the system-recorded fact.
    expect((await transitionStage(db, ops, projectId, 'QUALIFIED')).ok).toBe(true);
    expect((await transitionStage(db, ops, projectId, 'QUOTED')).ok).toBe(true);

    const view = await getQuoteByToken(db, token);
    expect(view?.quote.id).toBe(q.id);
    expect(view?.firstName).toBe('Asha');
    await getQuoteByToken(db, token); // second view within the hour is not re-logged
    expect(await getQuoteByToken(db, 'x'.repeat(32))).toBeNull();
    expect(await getQuoteByToken(db, '../../etc')).toBeNull();

    await expect(acceptQuote(db, ops, q.id, '')).rejects.toThrow(/Note/);
    await acceptQuote(db, ops, q.id, 'Customer confirmed on call');
    const d = await getProjectDetail(db, projectId);
    expect(d.snapshot.facts.quote_accepted_indicative).toBe(true);
    expect(d.events.filter((e) => e.type === 'proposal_viewed')).toHaveLength(1);
    expect(d.tasks.some((t) => t.type === 'quote_follow_up')).toBe(true);
  });

  it('engineers cannot generate quotes', async () => {
    const { projectId } = await qualifiedProject();
    const eng = await staff(db, 'engineer');
    await expect(generateQuote(db, eng, projectId, { grade: 'INDICATIVE' })).rejects.toThrow(
      /lacks/,
    );
  });

  it('turns calc errors into validation errors', async () => {
    const { ops, projectId } = await qualifiedProject();
    await expect(
      generateQuote(db, ops, projectId, { grade: 'FINAL', packageId: 'nope' }),
    ).rejects.toThrow(/Unknown package/);
  });
});

describe('bill extraction', () => {
  const good: BillExtraction = {
    isElectricityBill: true,
    fields: {
      consumerNumber: '1234567890',
      discom: 'DVVNL',
      tariffCategory: 'LMV-1',
      sanctionedLoadKw: 3,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      unitsKwh: 420,
      amountRupees: 3150,
      monthlyHistory: [{ month: '2026-07', units: 450 }],
    },
    confidence: {
      consumerNumber: 0.99,
      discom: 0.99,
      tariffCategory: 0.95,
      sanctionedLoadKw: 0.97,
      periodStart: 0.98,
      periodEnd: 0.98,
      unitsKwh: 0.99,
      amountRupees: 0.99,
    },
  };

  async function extract(extraction: BillExtraction | null, failure?: string) {
    const input = leadInput();
    const { projectId } = await seedLead(db, input);
    const aiActionId = await logAiAction(db, {
      projectId,
      agent: 'bill-agent',
      promptVersion: 'test',
      model: 'test',
      inputRef: { billId: input.bill!.id },
      outcome: extraction ? 'ok' : 'error',
    });
    const r = await recordBillExtraction(db, projectId, input.bill!.id, extraction, {
      threshold: 0.9,
      aiActionId,
      failure,
    });
    return { ...r, projectId, billId: input.bill!.id };
  }

  it('high-confidence extraction → EXTRACTED with a proposed (not confirmed) reading', async () => {
    const r = await extract(good);
    expect(r).toMatchObject({ state: 'EXTRACTED', problems: [] });
    const rows = await db
      .select()
      .from(billReadings)
      .where(eq(billReadings.projectId, r.projectId));
    expect(rows).toMatchObject([
      { status: 'proposed', source: 'ai', sanctionedLoadW: 3000, amountPaise: 315000 },
    ]);
    // Proposed readings never feed quotes.
    const ops = await staff(db, 'ops');
    await expect(generateQuote(db, ops, r.projectId, { grade: 'INDICATIVE' })).rejects.toThrow(
      /Confirm/,
    );
  });

  it('low confidence keeps the proposal but routes to manual review', async () => {
    const r = await extract({ ...good, confidence: { ...good.confidence, unitsKwh: 0.5 } });
    expect(r.state).toBe('NEEDS_MANUAL');
    expect(r.problems.join(' ')).toMatch(/Low confidence: unitsKwh/);
    const rows = await db
      .select()
      .from(billReadings)
      .where(eq(billReadings.projectId, r.projectId));
    expect(rows).toHaveLength(1);
  });

  it('missing fields, invalid values, non-bills and failures → NEEDS_MANUAL without a proposal', async () => {
    for (const [ex, re] of [
      [{ ...good, fields: { ...good.fields, unitsKwh: undefined } }, /could not be read/],
      [{ ...good, fields: { ...good.fields, periodStart: '2026-09-15' } }, /start must be before/],
      [{ ...good, isElectricityBill: false }, /not look like an electricity bill/],
      [null, /model timeout/],
    ] as const) {
      await reset(db);
      const r = await extract(ex as BillExtraction | null, ex ? undefined : 'model timeout');
      expect(r.state).toBe('NEEDS_MANUAL');
      expect(r.problems.join(' ')).toMatch(re);
      expect(
        await db.select().from(billReadings).where(eq(billReadings.projectId, r.projectId)),
      ).toHaveLength(0);
    }
  });

  it('does nothing if a person already handled the bill', async () => {
    const ops = await staff(db, 'ops');
    const input = leadInput();
    const { projectId } = await seedLead(db, input);
    await enterBillReadings(db, ops, projectId, reading(input.bill!.id));
    const r = await recordBillExtraction(db, projectId, input.bill!.id, good, {
      threshold: 0.9,
      aiActionId: 'x',
    });
    expect(r.state).toBe('UNCHANGED');
  });

  it('confirming an unchanged proposal promotes it; corrections are recorded', async () => {
    const ops = await staff(db, 'ops');
    const a = await extract(good);
    const [proposedA] = await db
      .select()
      .from(billReadings)
      .where(eq(billReadings.projectId, a.projectId));
    const r1 = await enterBillReadings(
      db,
      ops,
      a.projectId,
      { billId: a.billId, ...good.fields } as BillReadingInput,
      { proposedReadingId: proposedA!.id },
    );
    expect(r1.ok).toBe(true);
    const rowsA = await db
      .select()
      .from(billReadings)
      .where(eq(billReadings.projectId, a.projectId));
    expect(rowsA).toMatchObject([
      { id: proposedA!.id, status: 'confirmed', source: 'ai', confirmedBy: ops.id },
    ]);

    await reset(db);
    const ops2 = await staff(db, 'ops');
    const b = await extract(good);
    const [proposedB] = await db
      .select()
      .from(billReadings)
      .where(eq(billReadings.projectId, b.projectId));
    await enterBillReadings(
      db,
      ops2,
      b.projectId,
      { billId: b.billId, ...good.fields, unitsKwh: 421 } as BillReadingInput,
      { proposedReadingId: proposedB!.id },
    );
    const rowsB = await db
      .select()
      .from(billReadings)
      .where(eq(billReadings.projectId, b.projectId));
    expect(rowsB.map((x) => [x.status, x.source]).sort()).toEqual([
      ['confirmed', 'ai_corrected'],
      ['rejected', 'ai'],
    ]);
    const d = await getProjectDetail(db, b.projectId);
    const reviewed = d.events.find((e) => e.type === 'bill_readings_reviewed');
    expect(reviewed?.payload.correctedFields).toEqual(['unitsKwh']);
    await expect(
      enterBillReadings(
        db,
        ops2,
        b.projectId,
        { billId: b.billId, ...good.fields } as BillReadingInput,
        { proposedReadingId: proposedB!.id },
      ),
    ).rejects.toThrow(/no longer pending/);
  });
});
