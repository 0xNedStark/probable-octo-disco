import { newId } from '@solar/domain';
import { and, desc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../client';
import { billReadings, electricityBills, fileAccessLog, type MonthlyUsage } from '../schema';
import { authorize, ServiceError, type ServiceActor } from './common';
import { createTask } from './leads';
import {
  applyWorkstreamTransition,
  lockProject,
  queueCustomerMessage,
  recordEvent,
  type TransitionOutcome,
} from './projects';

export interface BillReadingInput {
  billId: string;
  consumerNumber: string;
  discom: string;
  tariffCategory: string;
  sanctionedLoadKw: number;
  periodStart: string;
  periodEnd: string;
  unitsKwh: number;
  amountRupees: number;
  monthlyHistory: MonthlyUsage[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function validateReading(r: BillReadingInput): string[] {
  const errors: string[] = [];
  if (!r.consumerNumber.trim()) errors.push('Consumer number is required.');
  if (!r.discom.trim()) errors.push('DISCOM is required.');
  if (!r.tariffCategory.trim()) errors.push('Tariff category is required.');
  if (!(r.sanctionedLoadKw > 0 && r.sanctionedLoadKw <= 100)) {
    errors.push('Sanctioned load must be between 0 and 100 kW.');
  }
  if (!ISO_DATE.test(r.periodStart) || !ISO_DATE.test(r.periodEnd)) {
    errors.push('Billing period dates must be YYYY-MM-DD.');
  } else if (r.periodStart >= r.periodEnd) {
    errors.push('Billing period start must be before its end.');
  }
  if (!(Number.isInteger(r.unitsKwh) && r.unitsKwh >= 0 && r.unitsKwh <= 100_000)) {
    errors.push('Units must be a whole number of kWh.');
  }
  if (!(r.amountRupees >= 0 && r.amountRupees <= 10_000_000))
    errors.push('Bill amount is invalid.');
  for (const m of r.monthlyHistory) {
    if (!MONTH.test(m.month) || !(Number.isInteger(m.units) && m.units >= 0)) {
      errors.push(`Invalid monthly history entry ${m.month}: ${m.units}.`);
    }
  }
  return errors;
}

/**
 * Ops reads the bill and enters the values (manual path; the Bill Agent will use
 * the same function with source 'ai' in weeks 3–4). Confirms the bill workstream.
 */
const READING_FIELDS = [
  'consumerNumber',
  'discom',
  'tariffCategory',
  'sanctionedLoadKw',
  'periodStart',
  'periodEnd',
  'unitsKwh',
  'amountRupees',
] as const;

type ReadingRow = typeof billReadings.$inferSelect;

function rowToInput(r: ReadingRow): Omit<BillReadingInput, 'billId'> {
  return {
    consumerNumber: r.consumerNumber,
    discom: r.discom,
    tariffCategory: r.tariffCategory,
    sanctionedLoadKw: r.sanctionedLoadW / 1000,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    unitsKwh: r.unitsKwh,
    amountRupees: r.amountPaise / 100,
    monthlyHistory: r.monthlyHistory,
  };
}

/** Fields where the human-confirmed value differs from the AI proposal. */
export function correctedFields(proposed: ReadingRow, confirmed: BillReadingInput): string[] {
  const p = rowToInput(proposed);
  const fields: string[] = READING_FIELDS.filter((f) => {
    const a = p[f];
    const b = confirmed[f];
    return typeof a === 'string' ? a.trim() !== String(b).trim() : Number(a) !== Number(b);
  });
  if (canonical(p.monthlyHistory) !== canonical(confirmed.monthlyHistory))
    fields.push('monthlyHistory');
  return fields;
}

const canonical = (h: MonthlyUsage[]) =>
  JSON.stringify(
    [...h].sort((a, b) => a.month.localeCompare(b.month)).map((m) => [m.month, m.units]),
  );

/**
 * A person confirms bill readings: either typed from the bill, or reviewed from
 * an AI proposal (proposedReadingId). Only confirmed readings feed quotes.
 */
export async function enterBillReadings(
  db: DbOrTx,
  actor: ServiceActor,
  projectId: string,
  input: BillReadingInput,
  opts: { proposedReadingId?: string } = {},
): Promise<TransitionOutcome> {
  authorize(actor, 'bill.enter_readings');
  const errors = validateReading(input);
  if (errors.length) throw new ServiceError('INVALID', errors.join(' '));

  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    const [bill] = await tx
      .select({ id: electricityBills.id })
      .from(electricityBills)
      .where(and(eq(electricityBills.id, input.billId), eq(electricityBills.projectId, projectId)));
    if (!bill) throw new ServiceError('NOT_FOUND', 'Bill not found on this project.');

    let proposed: ReadingRow | undefined;
    if (opts.proposedReadingId) {
      [proposed] = await tx
        .select()
        .from(billReadings)
        .where(
          and(
            eq(billReadings.id, opts.proposedReadingId),
            eq(billReadings.projectId, projectId),
            eq(billReadings.status, 'proposed'),
          ),
        );
      if (!proposed) throw new ServiceError('CONFLICT', 'That AI proposal is no longer pending.');
    }

    if (p.billState === 'RECEIVED') {
      const r = await applyWorkstreamTransition(
        tx,
        actor,
        p,
        'bill',
        'NEEDS_MANUAL',
        'manual entry',
      );
      if (!r.ok) return r;
    }

    const userId = actor.type === 'user' ? actor.id : null;
    const corrected = proposed ? correctedFields(proposed, input) : [];
    if (proposed && corrected.length === 0) {
      await tx
        .update(billReadings)
        .set({ status: 'confirmed', confirmedBy: userId, confirmedAt: new Date() })
        .where(eq(billReadings.id, proposed.id));
    } else {
      if (proposed) {
        await tx
          .update(billReadings)
          .set({ status: 'rejected' })
          .where(eq(billReadings.id, proposed.id));
      }
      await tx.insert(billReadings).values({
        id: newId('reading'),
        billId: input.billId,
        projectId,
        consumerNumber: input.consumerNumber.trim(),
        discom: input.discom.trim(),
        tariffCategory: input.tariffCategory.trim(),
        sanctionedLoadW: Math.round(input.sanctionedLoadKw * 1000),
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        unitsKwh: input.unitsKwh,
        amountPaise: Math.round(input.amountRupees * 100),
        monthlyHistory: input.monthlyHistory,
        source: proposed ? 'ai_corrected' : 'manual',
        status: 'confirmed',
        enteredBy: userId,
        confirmedBy: userId,
        confirmedAt: new Date(),
      });
    }
    const reason = proposed
      ? corrected.length
        ? `AI readings corrected: ${corrected.join(', ')}`
        : 'AI readings confirmed unchanged'
      : 'readings entered';
    const r = await applyWorkstreamTransition(tx, actor, p, 'bill', 'CONFIRMED', reason);
    if (r.ok && proposed) {
      await recordEvent(tx, {
        projectId,
        type: 'bill_readings_reviewed',
        actor,
        payload: { proposedReadingId: proposed.id, correctedFields: corrected },
      });
    }
    return r;
  });
}

/** Output of the Bill Agent, independent of the model provider. */
export interface BillExtraction {
  isElectricityBill: boolean;
  fields: Partial<Omit<BillReadingInput, 'billId'>>;
  /** 0..1 per field name in READING_FIELDS. */
  confidence: Partial<Record<(typeof READING_FIELDS)[number], number>>;
}

/**
 * Store an AI extraction as a *proposed* reading and route the bill workstream:
 * EXTRACTED when every required field is present, valid and above the
 * confidence threshold; otherwise NEEDS_MANUAL. A human always confirms.
 */
export async function recordBillExtraction(
  db: DbOrTx,
  projectId: string,
  billId: string,
  extraction: BillExtraction | null,
  opts: { threshold: number; aiActionId: string; failure?: string },
): Promise<{ state: 'EXTRACTED' | 'NEEDS_MANUAL' | 'UNCHANGED'; problems: string[] }> {
  const actor: ServiceActor = { type: 'agent', id: 'bill-agent' };
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    const [bill] = await tx
      .select({ id: electricityBills.id })
      .from(electricityBills)
      .where(and(eq(electricityBills.id, billId), eq(electricityBills.projectId, projectId)));
    if (!bill) throw new ServiceError('NOT_FOUND', 'Bill not found on this project.');
    // Only act on a bill that is still waiting for review.
    if (p.billState !== 'RECEIVED')
      return { state: 'UNCHANGED' as const, problems: [`bill is ${p.billState}`] };

    const problems: string[] = [];
    if (opts.failure) problems.push(opts.failure);
    if (extraction && !extraction.isElectricityBill)
      problems.push('Document does not look like an electricity bill.');

    const f = extraction?.fields ?? {};
    const complete = READING_FIELDS.every(
      (k) => f[k] !== undefined && f[k] !== null && f[k] !== '',
    );
    const v = { monthlyHistory: [], ...f } as Omit<BillReadingInput, 'billId'>;
    let valid = false;
    if (extraction?.isElectricityBill) {
      if (!complete) problems.push('Some fields could not be read.');
      const low = READING_FIELDS.filter((k) => (extraction.confidence[k] ?? 0) < opts.threshold);
      if (low.length) problems.push(`Low confidence: ${low.join(', ')}.`);
      if (complete) {
        const errs = validateReading({ billId, ...v });
        problems.push(...errs);
        valid = errs.length === 0;
      }
    }

    // A valid proposal is stored even when confidence is low: it pre-fills the review form.
    if (extraction?.isElectricityBill && valid) {
      await tx.insert(billReadings).values({
        id: newId('reading'),
        billId,
        projectId,
        consumerNumber: v.consumerNumber.trim(),
        discom: v.discom.trim(),
        tariffCategory: v.tariffCategory.trim(),
        sanctionedLoadW: Math.round(v.sanctionedLoadKw * 1000),
        periodStart: v.periodStart,
        periodEnd: v.periodEnd,
        unitsKwh: v.unitsKwh,
        amountPaise: Math.round(v.amountRupees * 100),
        monthlyHistory: v.monthlyHistory.filter(
          (m) =>
            /^\d{4}-(0[1-9]|1[0-2])$/.test(m.month) && Number.isInteger(m.units) && m.units >= 0,
        ),
        source: 'ai',
        status: 'proposed',
        confidence: extraction.confidence as Record<string, number>,
      });
    }

    const state = problems.length === 0 ? 'EXTRACTED' : 'NEEDS_MANUAL';
    await applyWorkstreamTransition(
      tx,
      actor,
      p,
      'bill',
      state,
      problems.join(' ') || 'all fields read with high confidence',
    );
    await recordEvent(tx, {
      projectId,
      type: 'bill_extracted',
      actor,
      to: state,
      payload: { billId, aiActionId: opts.aiActionId, problems },
    });
    return { state, problems };
  });
}

export async function requestBillResubmit(
  db: DbOrTx,
  actor: ServiceActor,
  projectId: string,
  reason: string,
): Promise<TransitionOutcome> {
  authorize(actor, 'bill.enter_readings');
  if (!reason.trim()) throw new ServiceError('INVALID', 'Say what is wrong with the bill.');
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    const r = await applyWorkstreamTransition(
      tx,
      actor,
      p,
      'bill',
      'NEEDS_RESUBMIT',
      reason.trim(),
    );
    if (!r.ok) return r;
    await createTask(tx, 'bill_resubmit_follow_up', projectId);
    await queueCustomerMessage(tx, projectId, 'bill_resubmit', { reason: reason.trim() });
    return r;
  });
}

export async function latestReading(db: DbOrTx, projectId: string) {
  const [row] = await db
    .select()
    .from(billReadings)
    .where(and(eq(billReadings.projectId, projectId), eq(billReadings.status, 'confirmed')))
    .orderBy(desc(billReadings.createdAt))
    .limit(1);
  return row ?? null;
}

/** Fetch a bill for a staff member to view, logging the access. */
export async function openBillForStaff(db: DbOrTx, actor: ServiceActor, billId: string) {
  authorize(actor, 'file.read_personal');
  if (actor.type !== 'user') throw new ServiceError('FORBIDDEN', 'Only staff can open bills.');
  const [bill] = await db.select().from(electricityBills).where(eq(electricityBills.id, billId));
  if (!bill) throw new ServiceError('NOT_FOUND', 'Bill not found.');
  await db.insert(fileAccessLog).values({
    id: newId('fileAccess'),
    userId: actor.id,
    billId,
    projectId: bill.projectId,
  });
  return bill;
}
