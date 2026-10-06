import { newId } from '@solar/domain';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../client';
import {
  customers,
  ledgerEntries,
  payments,
  solarProjects,
  solarQuotes,
  webhookEvents,
} from '../schema';
import { authorize, ServiceError, SYSTEM, type ServiceActor } from './common';
import { activeConfig } from './config';
import { createTask } from './leads';
import {
  autoAdvance,
  lockProject,
  queueCustomerMessage,
  recordEvent,
  recordFact,
} from './projects';

export type PaymentRow = typeof payments.$inferSelect;

/** Provider-agnostic shapes (implemented in @solar/integrations). */
export interface PaymentLinkCreator {
  readonly name: string;
  createLink(req: {
    reference: string;
    amountPaise: number;
    description: string;
    customer: { name: string; phone: string };
    callbackUrl: string;
    expiresAt: Date;
  }): Promise<{ providerRef: string; payUrl: string }>;
}

export interface PaymentEventInput {
  eventId: string;
  type: string;
  kind: 'paid' | 'expired' | 'cancelled' | 'ignored';
  reference: string | null;
  providerRef: string | null;
  providerPaymentId: string | null;
  amountPaise: number | null;
  method: string | null;
}

/** Ledger accounts. Customer money is a liability until the project delivers. */
export const ACCOUNTS = {
  gateway: 'asset:gateway_clearing',
  bank: 'asset:bank',
  customerAdvance: 'liability:customer_advance',
} as const;

const LINK_VALIDITY_MS = 3 * 24 * 60 * 60 * 1000;
const BOOKING_PATH = ['LEAD', 'QUALIFIED', 'QUOTED', 'BOOKED'] as const;

async function postLedger(
  tx: Tx,
  e: {
    projectId: string;
    paymentId: string | null;
    debit: string;
    credit: string;
    amountPaise: number;
    memo: string;
    actor: ServiceActor;
  },
) {
  await tx.insert(ledgerEntries).values({
    id: newId('ledger'),
    projectId: e.projectId,
    paymentId: e.paymentId,
    debitAccount: e.debit,
    creditAccount: e.credit,
    amountPaise: e.amountPaise,
    memo: e.memo,
    actorType: e.actor.type,
    actorId: e.actor.id,
  });
}

export async function listPayments(db: DbOrTx, projectId: string): Promise<PaymentRow[]> {
  return db
    .select()
    .from(payments)
    .where(eq(payments.projectId, projectId))
    .orderBy(desc(payments.createdAt));
}

/** Customer money held for a project (advances received minus refunds). */
export async function customerAdvanceBalance(db: DbOrTx, projectId: string): Promise<number> {
  const [row] = await db
    .select({
      balance:
        sql<number>`coalesce(sum(case when ${ledgerEntries.creditAccount} = ${ACCOUNTS.customerAdvance} then ${ledgerEntries.amountPaise} else 0 end)
        - sum(case when ${ledgerEntries.debitAccount} = ${ACCOUNTS.customerAdvance} then ${ledgerEntries.amountPaise} else 0 end), 0)`.mapWith(
          Number,
        ),
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.projectId, projectId));
  return row?.balance ?? 0;
}

export async function listLedger(db: DbOrTx, projectId: string) {
  return db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.projectId, projectId))
    .orderBy(desc(ledgerEntries.createdAt));
}

/**
 * Request the booking token for an accepted indicative quote. Idempotent: an
 * open, unexpired link is reused. The provider call happens outside the DB
 * transaction; a failed call leaves a CREATED payment without a link to retry.
 */
export async function requestBookingPayment(
  db: DbOrTx,
  actor: ServiceActor,
  projectId: string,
  provider: PaymentLinkCreator,
  publicBaseUrl: string,
): Promise<PaymentRow> {
  if (actor.type === 'user') authorize(actor, 'quote.manage');
  const prepared = await db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const [paid] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.projectId, projectId),
          eq(payments.purpose, 'booking_advance'),
          eq(payments.status, 'PAID'),
        ),
      );
    if (paid) throw new ServiceError('CONFLICT', 'The booking advance is already paid.');
    const [quote] = await tx
      .select()
      .from(solarQuotes)
      .where(
        and(
          eq(solarQuotes.projectId, projectId),
          eq(solarQuotes.grade, 'INDICATIVE'),
          eq(solarQuotes.status, 'ACCEPTED'),
        ),
      )
      .orderBy(desc(solarQuotes.version))
      .limit(1);
    if (!quote) throw new ServiceError('CONFLICT', 'The customer has not accepted a quote yet.');

    const [open] = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.projectId, projectId),
          eq(payments.purpose, 'booking_advance'),
          eq(payments.status, 'CREATED'),
        ),
      )
      .orderBy(desc(payments.createdAt))
      .limit(1);
    if (
      open &&
      open.provider === provider.name &&
      (open.payUrl === null || Date.now() - open.createdAt.getTime() < LINK_VALIDITY_MS - 3_600_000)
    ) {
      return { payment: open, fresh: false };
    }
    if (open) await tx.update(payments).set({ status: 'EXPIRED' }).where(eq(payments.id, open.id));

    const config = await activeConfig(tx);
    const [payment] = await tx
      .insert(payments)
      .values({
        id: newId('payment'),
        projectId,
        purpose: 'booking_advance',
        amountPaise: config.bundle.commercial.bookingTokenPaise,
        provider: provider.name,
        commercialConfigId: config.ids.commercial,
        quoteId: quote.id,
        createdBy: actor.type === 'user' ? actor.id : null,
      })
      .returning();
    await recordEvent(tx, {
      projectId,
      type: 'payment_requested',
      actor,
      to: 'booking_advance',
      payload: { paymentId: payment!.id, amountPaise: payment!.amountPaise },
    });
    return { payment: payment!, fresh: true };
  });

  let payment = prepared.payment;
  if (payment.payUrl) return payment;
  const [cust] = await db
    .select({ name: customers.name, phone: customers.phone, code: solarProjects.code })
    .from(solarProjects)
    .innerJoin(customers, eq(customers.id, solarProjects.customerId))
    .where(eq(solarProjects.id, projectId));
  const link = await provider.createLink({
    reference: payment.id,
    amountPaise: payment.amountPaise,
    description: `Booking token for rooftop solar ${cust!.code}`,
    customer: { name: cust!.name, phone: cust!.phone },
    callbackUrl: `${publicBaseUrl.replace(/\/$/, '')}/pay/return?payment=${payment.id}`,
    expiresAt: new Date(Date.now() + LINK_VALIDITY_MS),
  });
  await db.transaction(async (tx) => {
    [payment] = (await tx
      .update(payments)
      .set({ providerRef: link.providerRef, payUrl: link.payUrl })
      .where(eq(payments.id, payment.id))
      .returning()) as [PaymentRow];
    await queueCustomerMessage(tx, projectId, 'payment_link', {
      url: link.payUrl,
      amountPaise: payment.amountPaise,
    });
  });
  return payment;
}

/** Shared bookkeeping once money has arrived (gateway or manual). */
async function settlePaid(
  tx: Tx,
  actor: ServiceActor,
  payment: PaymentRow,
  debitAccount: string,
  note: string,
) {
  await postLedger(tx, {
    projectId: payment.projectId,
    paymentId: payment.id,
    debit: debitAccount,
    credit: ACCOUNTS.customerAdvance,
    amountPaise: payment.amountPaise,
    memo: `${payment.purpose} received (${note})`,
    actor,
  });
  await recordEvent(tx, {
    projectId: payment.projectId,
    type: 'payment_received',
    actor,
    to: payment.purpose,
    reason: note,
    payload: {
      paymentId: payment.id,
      amountPaise: payment.amountPaise,
      provider: payment.provider,
    },
  });
  await queueCustomerMessage(tx, payment.projectId, 'payment_received', {
    amountPaise: payment.amountPaise,
    purpose: payment.purpose,
  });
  if (payment.purpose === 'booking_advance') {
    await recordFact(
      tx,
      SYSTEM,
      payment.projectId,
      'booking_advance',
      true,
      `Payment ${payment.id}: ${note}`,
    );
    const moved = await autoAdvance(
      tx,
      payment.projectId,
      BOOKING_PATH,
      'booking advance received',
    );
    if (moved.includes('BOOKED')) await createTask(tx, 'schedule_survey', payment.projectId);
  }
}

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'rejected';

/**
 * Process a verified payment webhook exactly once. The raw event is stored first;
 * a retry of an already-processed event is a no-op.
 */
export async function processPaymentEvent(
  db: DbOrTx,
  provider: string,
  event: PaymentEventInput,
  rawPayload: Record<string, unknown>,
): Promise<{ outcome: WebhookOutcome; detail?: string }> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(webhookEvents)
      .values({
        id: newId('webhook'),
        provider,
        eventId: event.eventId,
        type: event.type,
        payload: rawPayload,
      })
      .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.eventId] })
      .returning({ id: webhookEvents.id });
    let hookId = inserted[0]?.id;
    if (!hookId) {
      const [existing] = await tx
        .select()
        .from(webhookEvents)
        .where(and(eq(webhookEvents.provider, provider), eq(webhookEvents.eventId, event.eventId)))
        .for('update');
      if (existing?.processedAt) return { outcome: 'duplicate' as const };
      hookId = existing!.id;
    }
    const finish = async (outcome: WebhookOutcome, detail?: string) => {
      await tx
        .update(webhookEvents)
        .set({
          processedAt: new Date(),
          error: outcome === 'rejected' ? (detail ?? 'rejected') : null,
        })
        .where(eq(webhookEvents.id, hookId!));
      return { outcome, detail };
    };

    if (event.kind === 'ignored') return finish('ignored', event.type);
    const [payment] = await tx
      .select()
      .from(payments)
      .where(
        event.reference
          ? eq(payments.id, event.reference)
          : eq(payments.providerRef, event.providerRef ?? '__none__'),
      )
      .for('update');
    if (!payment) return finish('rejected', 'unknown payment');
    await lockProject(tx, payment.projectId);

    if (event.kind !== 'paid') {
      if (payment.status === 'CREATED') {
        await tx
          .update(payments)
          .set({ status: event.kind === 'expired' ? 'EXPIRED' : 'CANCELLED' })
          .where(eq(payments.id, payment.id));
      }
      return finish('processed', event.kind);
    }
    if (payment.status === 'PAID') return finish('duplicate', 'already paid');
    if (event.amountPaise !== payment.amountPaise) {
      await createTask(tx, 'payment_review', payment.projectId, {
        title: `Payment ${payment.id}: received ${event.amountPaise ?? '?'} paise, expected ${payment.amountPaise}`,
      });
      return finish('rejected', 'amount mismatch');
    }
    const [paid] = (await tx
      .update(payments)
      .set({ status: 'PAID', paidAt: new Date(), providerPaymentId: event.providerPaymentId })
      .where(eq(payments.id, payment.id))
      .returning()) as [PaymentRow];
    await settlePaid(
      tx,
      { type: 'system', id: `webhook:${provider}` },
      paid,
      ACCOUNTS.gateway,
      `${provider} ${event.method ?? ''} ${event.providerPaymentId ?? ''}`.trim(),
    );
    return finish('processed');
  });
}

/** Finance records a UPI / bank transfer received outside the gateway. */
export async function recordManualPayment(
  db: DbOrTx,
  actor: ServiceActor,
  projectId: string,
  input: {
    purpose: 'booking_advance' | 'milestone' | 'other';
    amountPaise: number;
    reference: string;
  },
): Promise<PaymentRow> {
  authorize(actor, 'payment.manage');
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0)
    throw new ServiceError('INVALID', 'Amount must be positive.');
  if (!input.reference.trim())
    throw new ServiceError('INVALID', 'Enter the UPI / bank reference (UTR).');
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    if (input.purpose === 'booking_advance') {
      const [paid] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.projectId, projectId),
            eq(payments.purpose, 'booking_advance'),
            eq(payments.status, 'PAID'),
          ),
        );
      if (paid) throw new ServiceError('CONFLICT', 'The booking advance is already paid.');
      // Any open gateway link for the same purpose is now moot.
      await tx
        .update(payments)
        .set({ status: 'CANCELLED' })
        .where(
          and(
            eq(payments.projectId, projectId),
            eq(payments.purpose, 'booking_advance'),
            eq(payments.status, 'CREATED'),
          ),
        );
    }
    const config = await activeConfig(tx);
    const [payment] = (await tx
      .insert(payments)
      .values({
        id: newId('payment'),
        projectId,
        purpose: input.purpose,
        amountPaise: input.amountPaise,
        status: 'PAID',
        provider: 'manual',
        reference: input.reference.trim(),
        commercialConfigId: config.ids.commercial,
        createdBy: actor.type === 'user' ? actor.id : null,
        paidAt: new Date(),
      })
      .returning()) as [PaymentRow];
    await settlePaid(tx, actor, payment, ACCOUNTS.bank, `manual ${input.reference.trim()}`);
    return payment;
  });
}

/**
 * Record a refund paid back to the customer (bank transfer or gateway dashboard).
 * The amount follows the refund policy; staff decide deductions and note why.
 */
export async function recordRefund(
  db: DbOrTx,
  actor: ServiceActor,
  paymentId: string,
  input: { amountPaise: number; reference: string; reason: string },
): Promise<void> {
  authorize(actor, 'payment.manage');
  if (!input.reference.trim() || !input.reason.trim())
    throw new ServiceError('INVALID', 'Reference and reason are required.');
  await db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .for('update');
    if (!payment) throw new ServiceError('NOT_FOUND', 'Payment not found.');
    if (payment.status !== 'PAID')
      throw new ServiceError('CONFLICT', 'Only a paid payment can be refunded.');
    await lockProject(tx, payment.projectId);
    const [row] = await tx
      .select({
        refunded: sql<number>`coalesce(sum(${ledgerEntries.amountPaise}), 0)`.mapWith(Number),
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.paymentId, paymentId),
          eq(ledgerEntries.debitAccount, ACCOUNTS.customerAdvance),
        ),
      );
    const remaining = payment.amountPaise - (row?.refunded ?? 0);
    if (
      !Number.isInteger(input.amountPaise) ||
      input.amountPaise <= 0 ||
      input.amountPaise > remaining
    ) {
      throw new ServiceError(
        'INVALID',
        `Refund must be between ₹0.01 and the ₹${remaining / 100} still held.`,
      );
    }
    await postLedger(tx, {
      projectId: payment.projectId,
      paymentId,
      debit: ACCOUNTS.customerAdvance,
      credit: payment.provider === 'manual' ? ACCOUNTS.bank : ACCOUNTS.gateway,
      amountPaise: input.amountPaise,
      memo: `refund (${input.reference.trim()}): ${input.reason.trim()}`,
      actor,
    });
    const full = input.amountPaise === remaining;
    if (full)
      await tx
        .update(payments)
        .set({ status: 'REFUNDED', refundedAt: new Date() })
        .where(eq(payments.id, paymentId));
    await recordEvent(tx, {
      projectId: payment.projectId,
      type: 'refund_recorded',
      actor,
      to: full ? 'full' : 'partial',
      reason: input.reason.trim(),
      payload: { paymentId, amountPaise: input.amountPaise, reference: input.reference.trim() },
    });
    if (full && payment.purpose === 'booking_advance') {
      await recordFact(
        tx,
        SYSTEM,
        payment.projectId,
        'booking_advance',
        false,
        `Refunded: ${input.reason.trim()}`,
      );
    }
  });
}

export async function getPayment(db: DbOrTx, paymentId: string): Promise<PaymentRow | null> {
  const [p] = await db.select().from(payments).where(eq(payments.id, paymentId));
  return p ?? null;
}

export async function openPayments(db: DbOrTx, projectId: string): Promise<PaymentRow[]> {
  return db
    .select()
    .from(payments)
    .where(and(eq(payments.projectId, projectId), inArray(payments.status, ['CREATED'])))
    .orderBy(desc(payments.createdAt));
}
