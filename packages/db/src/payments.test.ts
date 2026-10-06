import { UP_DVVNL_SEED } from '@solar/calc';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ledgerEntries, otpChallenges, outbox, payments } from './schema';
import { acceptWithOtp, requestAcceptanceOtp } from './services/acceptance';
import { enterBillReadings } from './services/bills';
import { publishConfig } from './services/config';
import { statusToken, statusUrl, verifyStatusToken } from './services/links';
import {
  customerAdvanceBalance,
  processPaymentEvent,
  recordManualPayment,
  recordRefund,
  requestBookingPayment,
  type PaymentEventInput,
  type PaymentLinkCreator,
} from './services/payments';
import { getProjectDetail } from './services/queries';
import { acceptQuote, generateQuote, sendQuote } from './services/quotes';
import { leadInput, reset, seedLead, staff, testDb } from './test/helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const links: { reference: string; amountPaise: number }[] = [];
const provider: PaymentLinkCreator = {
  name: 'dev',
  async createLink(req) {
    links.push({ reference: req.reference, amountPaise: req.amountPaise });
    return { providerRef: `plink_${req.reference}`, payUrl: `https://pay.test/${req.reference}` };
  },
};

/** A project with a sent indicative quote; returns its customer token. */
async function sentQuote() {
  const ops = await staff(db, 'ops');
  const admin = await staff(db, 'admin');
  await publishConfig(
    db,
    admin,
    'pricebook',
    { ...UP_DVVNL_SEED.pricebook, placeholder: false },
    'real prices',
  );
  const input = leadInput();
  const { projectId } = await seedLead(db, input);
  await enterBillReadings(db, ops, projectId, {
    billId: input.bill!.id,
    consumerNumber: '1234567890',
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
  const { token } = await sendQuote(db, ops, q.id, 'https://example.test');
  return { ops, projectId, quoteId: q.id, token };
}

async function lastOtpCode(): Promise<string> {
  const rows = (await db.select().from(outbox)).filter((m) => m.template === 'otp');
  return String(rows[rows.length - 1]!.payload.code);
}

const paidEvent = (
  paymentId: string,
  amountPaise: number,
  eventId = `evt_${paymentId}`,
): PaymentEventInput => ({
  eventId,
  type: 'payment_link.paid',
  kind: 'paid',
  reference: paymentId,
  providerRef: `plink_${paymentId}`,
  providerPaymentId: `pay_${paymentId}`,
  amountPaise,
  method: 'upi',
});

describe('customer OTP acceptance', () => {
  it('accepts with the right code and records consent to the refund policy', async () => {
    const { projectId, quoteId, token } = await sentQuote();
    const { maskedPhone } = await requestAcceptanceOtp(db, token);
    expect(maskedPhone).toBe('+91••••••10');
    const code = await lastOtpCode();
    const r = await acceptWithOtp(db, token, code, { ip: '203.0.113.9', userAgent: 'test' });
    expect(r).toEqual({ projectId, quoteId, grade: 'INDICATIVE' });

    const d = await getProjectDetail(db, projectId);
    expect(d.snapshot.facts.quote_accepted_indicative).toBe(true);
    expect(d.consents.find((c) => c.purpose === 'quote_terms')?.textVersion).toBe(
      `refund-v1-2026-10|quote:${quoteId}`,
    );
    const ev = d.events.find((e) => e.type === 'quote_accepted');
    expect(ev?.payload).toMatchObject({
      ip: '203.0.113.9',
      refundPolicyVersion: 'refund-v1-2026-10',
    });
    await expect(acceptWithOtp(db, token, code, {})).rejects.toThrow(/already accepted/);
  });

  it('rejects wrong codes, locks after 5 attempts, and rate-limits sends', async () => {
    const { token } = await sentQuote();
    await requestAcceptanceOtp(db, token);
    const code = await lastOtpCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      await expect(acceptWithOtp(db, token, wrong, {})).rejects.toThrow(/not right/);
    await expect(acceptWithOtp(db, token, code, {})).rejects.toThrow(/Too many wrong attempts/);
    await requestAcceptanceOtp(db, token);
    await requestAcceptanceOtp(db, token);
    await expect(requestAcceptanceOtp(db, token)).rejects.toThrow(/Too many codes/);
  });

  it('rejects expired codes', async () => {
    const { token } = await sentQuote();
    await requestAcceptanceOtp(db, token);
    const code = await lastOtpCode();
    await db.update(otpChallenges).set({ expiresAt: new Date(Date.now() - 1000) });
    await expect(acceptWithOtp(db, token, code, {})).rejects.toThrow(/expired/);
  });

  it('cannot accept an unknown or unsent proposal', async () => {
    await expect(requestAcceptanceOtp(db, 'x'.repeat(32))).rejects.toThrow(/not found/);
  });
});

describe('booking payment', () => {
  async function acceptedProject() {
    const s = await sentQuote();
    await requestAcceptanceOtp(db, s.token);
    await acceptWithOtp(db, s.token, await lastOtpCode(), {});
    return s;
  }

  it('requires an accepted quote', async () => {
    const { projectId } = await sentQuote();
    await expect(
      requestBookingPayment(
        db,
        { type: 'system', id: 'customer' },
        projectId,
        provider,
        'https://x.test',
      ),
    ).rejects.toThrow(/not accepted/);
  });

  it('creates one link (idempotent), and the paid webhook books the project once', async () => {
    const { projectId } = await acceptedProject();
    const actor = { type: 'system', id: 'customer' } as const;
    const p1 = await requestBookingPayment(db, actor, projectId, provider, 'https://x.test');
    const p2 = await requestBookingPayment(db, actor, projectId, provider, 'https://x.test');
    expect(p2.id).toBe(p1.id);
    expect(p1).toMatchObject({
      amountPaise: 500_000,
      status: 'CREATED',
      payUrl: `https://pay.test/${p1.id}`,
    });
    expect((await db.select().from(outbox)).some((m) => m.template === 'payment_link')).toBe(true);

    const raw = { any: 'payload' };
    expect(await processPaymentEvent(db, 'dev', paidEvent(p1.id, 500_000), raw)).toEqual({
      outcome: 'processed',
      detail: undefined,
    });
    expect((await processPaymentEvent(db, 'dev', paidEvent(p1.id, 500_000), raw)).outcome).toBe(
      'duplicate',
    );
    expect(
      (await processPaymentEvent(db, 'dev', paidEvent(p1.id, 500_000, 'evt_other'), raw)).outcome,
    ).toBe('duplicate');

    const d = await getProjectDetail(db, projectId);
    expect(d.project.stage).toBe('BOOKED'); // auto-advanced LEAD → QUALIFIED → QUOTED → BOOKED as each gate passes
    expect(d.snapshot.facts.booking_advance).toBe(true);
    expect(d.tasks.some((t) => t.type === 'schedule_survey')).toBe(true);
    expect(await customerAdvanceBalance(db, projectId)).toBe(500_000);
    const ledger = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.projectId, projectId));
    expect(ledger).toMatchObject([
      {
        debitAccount: 'asset:gateway_clearing',
        creditAccount: 'liability:customer_advance',
        amountPaise: 500_000,
      },
    ]);
    await expect(
      requestBookingPayment(db, actor, projectId, provider, 'https://x.test'),
    ).rejects.toThrow(/already paid/);
  });

  it('flags amount mismatches for review instead of booking', async () => {
    const { projectId } = await acceptedProject();
    const p = await requestBookingPayment(
      db,
      { type: 'system', id: 'c' },
      projectId,
      provider,
      'https://x.test',
    );
    const r = await processPaymentEvent(db, 'dev', paidEvent(p.id, 100), {});
    expect(r).toEqual({ outcome: 'rejected', detail: 'amount mismatch' });
    const d = await getProjectDetail(db, projectId);
    expect(d.snapshot.facts.booking_advance).toBeUndefined();
    expect(d.tasks.some((t) => t.type === 'payment_review')).toBe(true);
  });

  it('expired links are marked and unknown payments rejected', async () => {
    const { projectId } = await acceptedProject();
    const p = await requestBookingPayment(
      db,
      { type: 'system', id: 'c' },
      projectId,
      provider,
      'https://x.test',
    );
    await processPaymentEvent(
      db,
      'dev',
      { ...paidEvent(p.id, 0), kind: 'expired', type: 'payment_link.expired', eventId: 'e1' },
      {},
    );
    const [row] = await db.select().from(payments).where(eq(payments.id, p.id));
    expect(row?.status).toBe('EXPIRED');
    expect((await processPaymentEvent(db, 'dev', paidEvent('pay_nope', 1, 'e2'), {})).outcome).toBe(
      'rejected',
    );
    expect(
      (await processPaymentEvent(db, 'dev', { ...paidEvent(p.id, 1, 'e3'), kind: 'ignored' }, {}))
        .outcome,
    ).toBe('ignored');
  });

  it('manual payment by finance books the project; refunds reverse it', async () => {
    const { projectId } = await acceptedProject();
    const ops = await staff(db, 'ops');
    const finance = await staff(db, 'finance');
    await expect(
      recordManualPayment(db, ops, projectId, {
        purpose: 'booking_advance',
        amountPaise: 500_000,
        reference: 'UTR1',
      }),
    ).rejects.toThrow(/lacks/);
    await expect(
      recordManualPayment(db, finance, projectId, {
        purpose: 'booking_advance',
        amountPaise: 500_000,
        reference: ' ',
      }),
    ).rejects.toThrow(/reference/);
    const p = await recordManualPayment(db, finance, projectId, {
      purpose: 'booking_advance',
      amountPaise: 500_000,
      reference: 'UTR123',
    });
    expect((await getProjectDetail(db, projectId)).project.stage).toBe('BOOKED');

    await expect(
      recordRefund(db, finance, p.id, { amountPaise: 600_000, reference: 'R1', reason: 'x' }),
    ).rejects.toThrow(/Refund must be/);
    await recordRefund(db, finance, p.id, {
      amountPaise: 200_000,
      reference: 'R1',
      reason: 'survey fee kept',
    });
    expect(await customerAdvanceBalance(db, projectId)).toBe(300_000);
    await recordRefund(db, finance, p.id, {
      amountPaise: 300_000,
      reference: 'R2',
      reason: 'cancelled before survey',
    });
    expect(await customerAdvanceBalance(db, projectId)).toBe(0);
    const d = await getProjectDetail(db, projectId);
    expect(d.snapshot.facts.booking_advance).toBe(false);
    const [row] = await db.select().from(payments).where(eq(payments.id, p.id));
    expect(row?.status).toBe('REFUNDED');
  });

  it('ledger entries cannot be edited', async () => {
    const { projectId } = await acceptedProject();
    await recordManualPayment(db, await staff(db, 'finance'), projectId, {
      purpose: 'other',
      amountPaise: 100,
      reference: 'U',
    });
    await expect(db.update(ledgerEntries).set({ memo: 'x' })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/append-only/) },
    });
  });
});

describe('status links', () => {
  it('round-trips and rejects tampering', () => {
    const id = 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0';
    const t = statusToken(id, 's3cret');
    expect(verifyStatusToken(t, 's3cret')).toBe(id);
    expect(verifyStatusToken(t, 'other')).toBeNull();
    expect(verifyStatusToken(t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'), 's3cret')).toBeNull();
    expect(verifyStatusToken('garbage', 's3cret')).toBeNull();
    expect(statusUrl(id, 'https://x.test/', 's')).toMatch(/^https:\/\/x\.test\/s\/prj_/);
  });
});

it('ops-recorded acceptance still works alongside OTP', async () => {
  const { ops, quoteId, projectId } = await sentQuote();
  await acceptQuote(db, ops, quoteId, 'on call');
  expect((await getProjectDetail(db, projectId)).snapshot.facts.quote_accepted_indicative).toBe(
    true,
  );
});
