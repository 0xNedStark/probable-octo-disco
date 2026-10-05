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
export async function enterBillReadings(
  db: DbOrTx,
  actor: ServiceActor,
  projectId: string,
  input: BillReadingInput,
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

    if (p.billState === 'RECEIVED' || p.billState === 'EXTRACTED') {
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
      source: 'manual',
      enteredBy: actor.type === 'user' ? actor.id : null,
    });
    return applyWorkstreamTransition(tx, actor, p, 'bill', 'CONFIRMED', 'readings entered');
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
    .where(eq(billReadings.projectId, projectId))
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
