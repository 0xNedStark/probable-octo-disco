import { UP_DVVNL_SEED } from '@solar/calc';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { enterBillReadings } from './services/bills';
import { publishConfig } from './services/config';
import { chooseFinancePath, listLoans, updateLoan } from './services/loans';
import { getProjectDetail } from './services/queries';
import { acceptQuote, generateQuote, sendQuote } from './services/quotes';
import { leadInput, reset, seedLead, staff, testDb } from './test/helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

async function acceptedProject() {
  const ops = await staff(db, 'ops');
  const finance = await staff(db, 'finance');
  await publishConfig(
    db,
    await staff(db, 'admin'),
    'pricebook',
    { ...UP_DVVNL_SEED.pricebook, placeholder: false },
    'real',
  );
  const input = leadInput();
  const { projectId } = await seedLead(db, input);
  await enterBillReadings(db, ops, projectId, {
    billId: input.bill!.id,
    consumerNumber: '1',
    discom: 'DVVNL',
    tariffCategory: 'LMV-1-URBAN',
    sanctionedLoadKw: 5,
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    unitsKwh: 420,
    amountRupees: 3150,
    monthlyHistory: [],
  });
  const q = await generateQuote(db, ops, projectId, { grade: 'INDICATIVE' });
  await sendQuote(db, ops, q.id, 'https://x.test');
  await acceptQuote(db, ops, q.id, 'yes');
  return { projectId, finance, ops };
}

describe('finance tracker', () => {
  it('loan path: docs → submitted → sanctioned sets funds_secured; disbursal completes', async () => {
    const { projectId, finance } = await acceptedProject();
    const loan = (await chooseFinancePath(db, finance, projectId, {
      productId: 'sbi-psg-upto3kw',
    }))!;
    expect(loan).toMatchObject({
      lender: 'SBI',
      status: 'DOCS_PENDING',
      requestedPaise: 17_739_800,
    });
    expect(Object.keys(loan.checklist)).toHaveLength(6);

    const item = Object.keys(loan.checklist)[0]!;
    expect(
      (await updateLoan(db, finance, loan.id, { action: 'checklist', item, ready: true }))
        .checklist[item],
    ).toBe(true);
    await expect(
      updateLoan(db, finance, loan.id, { action: 'sanction', amountPaise: 1 }),
    ).rejects.toThrow(/docs pending/);
    await updateLoan(db, finance, loan.id, { action: 'submit', externalRef: 'JS-123' });
    await updateLoan(db, finance, loan.id, { action: 'sanction', amountPaise: 17_700_000 });
    let d = await getProjectDetail(db, projectId);
    expect(d.project.financeState).toBe('SANCTIONED');
    expect(d.snapshot.facts.funds_secured).toBe(true);
    await updateLoan(db, finance, loan.id, { action: 'disburse', amountPaise: 17_700_000 });
    d = await getProjectDetail(db, projectId);
    expect(d.project.financeState).toBe('DISBURSED');
    expect(d.events.filter((e) => e.type === 'loan_updated').map((e) => e.toValue)).toEqual([
      'DISBURSED',
      'SANCTIONED',
      'SUBMITTED',
    ]);
  });

  it('rejection creates a follow-up; customer can switch to cash', async () => {
    const { projectId, finance } = await acceptedProject();
    const loan = (await chooseFinancePath(db, finance, projectId, {
      productId: 'sbi-psg-upto3kw',
    }))!;
    await expect(chooseFinancePath(db, finance, projectId, 'cash')).rejects.toThrow(/Withdraw/);
    await updateLoan(db, finance, loan.id, { action: 'submit', externalRef: 'JS-1' });
    await updateLoan(db, finance, loan.id, { action: 'reject', reason: 'CIBIL score' });
    let d = await getProjectDetail(db, projectId);
    expect(d.project.financeState).toBe('REJECTED');
    expect(d.tasks.some((t) => /Loan rejected/.test(t.title))).toBe(true);
    await chooseFinancePath(db, finance, projectId, 'cash');
    d = await getProjectDetail(db, projectId);
    expect(d.project.financeState).toBe('NOT_REQUIRED');
  });

  it('withdrawing a submitted application allows a new one', async () => {
    const { projectId, finance } = await acceptedProject();
    const a = (await chooseFinancePath(db, finance, projectId, { productId: 'sbi-psg-upto3kw' }))!;
    await updateLoan(db, finance, a.id, { action: 'submit', externalRef: 'JS-1' });
    await updateLoan(db, finance, a.id, { action: 'withdraw', reason: 'wrong branch' });
    const b = await chooseFinancePath(db, finance, projectId, { productId: 'sbi-psg-upto3kw' });
    expect(b?.status).toBe('DOCS_PENDING');
    expect((await listLoans(db, projectId)).map((l) => l.status)).toEqual([
      'DOCS_PENDING',
      'WITHDRAWN',
    ]);
  });

  it('only products on the accepted quote, and only finance-capable roles', async () => {
    const { projectId, finance } = await acceptedProject();
    await expect(
      chooseFinancePath(db, finance, projectId, { productId: 'sbi-rooftop-3-10kw' }),
    ).rejects.toThrow(/not an option/);
    await expect(
      chooseFinancePath(db, await staff(db, 'sales'), projectId, 'cash'),
    ).rejects.toThrow(/lacks/);
  });
});
