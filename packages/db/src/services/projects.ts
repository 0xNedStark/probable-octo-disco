import {
  type Fact,
  type FactValues,
  type Stage,
  type StageSnapshot,
  type TransitionError,
  type Workstream,
  type WorkstreamState,
  type WorkstreamStates,
  canAttest,
  newId,
  planStageTransition,
  planWorkstreamTransition,
} from '@solar/domain';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../client';
import { customers, consents, outbox, projectEvents, projectFacts, solarProjects } from '../schema';
import { authorize, ServiceError, type ServiceActor } from './common';

type ProjectRow = typeof solarProjects.$inferSelect;

const WORKSTREAM_COLUMNS = {
  bill: 'billState',
  finance: 'financeState',
  regulatory: 'regulatoryState',
  procurement: 'procurementState',
  installation: 'installationState',
} as const satisfies Record<Workstream, keyof ProjectRow>;

export function workstreamsOf(p: ProjectRow): WorkstreamStates {
  return {
    bill: p.billState,
    finance: p.financeState,
    regulatory: p.regulatoryState,
    procurement: p.procurementState,
    installation: p.installationState,
  };
}

export async function currentFacts(db: DbOrTx, projectId: string): Promise<FactValues> {
  const rows = await db
    .selectDistinctOn([projectFacts.fact], { fact: projectFacts.fact, value: projectFacts.value })
    .from(projectFacts)
    .where(eq(projectFacts.projectId, projectId))
    .orderBy(projectFacts.fact, desc(projectFacts.createdAt), desc(projectFacts.id));
  return Object.fromEntries(rows.map((r) => [r.fact, r.value]));
}

/** Load a project under a row lock so concurrent transitions serialise. */
export async function lockProject(tx: Tx, projectId: string): Promise<ProjectRow> {
  const [row] = await tx
    .select()
    .from(solarProjects)
    .where(eq(solarProjects.id, projectId))
    .for('update');
  if (!row) throw new ServiceError('NOT_FOUND', `Project ${projectId} not found.`);
  return row;
}

export async function snapshotOf(db: DbOrTx, p: ProjectRow): Promise<StageSnapshot> {
  return {
    stage: p.stage,
    heldFromStage: p.heldFromStage,
    workstreams: workstreamsOf(p),
    facts: await currentFacts(db, p.id),
  };
}

export interface EventInput {
  projectId: string;
  type: string;
  actor: ServiceActor;
  from?: string | null;
  to?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown>;
}

export async function recordEvent(db: DbOrTx, e: EventInput): Promise<void> {
  await db.insert(projectEvents).values({
    id: newId('event'),
    projectId: e.projectId,
    type: e.type,
    actorType: e.actor.type,
    actorId: e.actor.id,
    fromValue: e.from ?? null,
    toValue: e.to ?? null,
    reason: e.reason ?? null,
    payload: e.payload ?? {},
  });
}

/** Queue a WhatsApp message if the customer has an active WhatsApp consent. */
export async function queueCustomerMessage(
  db: DbOrTx,
  projectId: string,
  template: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const [row] = await db
    .select({ phone: customers.phone, name: customers.name, consentId: consents.id })
    .from(solarProjects)
    .innerJoin(customers, eq(customers.id, solarProjects.customerId))
    .leftJoin(
      consents,
      and(
        eq(consents.customerId, customers.id),
        eq(consents.purpose, 'whatsapp'),
        sql`${consents.withdrawnAt} is null`,
      ),
    )
    .where(eq(solarProjects.id, projectId))
    .limit(1);
  if (!row?.consentId) return false;
  await db.insert(outbox).values({
    id: newId('outbox'),
    projectId,
    channel: 'whatsapp',
    template,
    recipient: row.phone,
    payload: { customerName: row.name, ...payload },
  });
  return true;
}

/** Queue background work for the worker in the same transaction as the change that needs it. */
export async function queueJob(
  db: DbOrTx,
  projectId: string | null,
  job: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(outbox).values({
    id: newId('outbox'),
    projectId,
    channel: 'internal',
    template: job,
    recipient: 'worker',
    payload,
  });
}

export type TransitionOutcome =
  { ok: true; from: string; to: string } | { ok: false; error: TransitionError };

/** Stages the customer hears about. LEAD is internal; QUALIFIED is not news to them. */
const NOTIFY_STAGES: readonly Stage[] = [
  'QUOTED',
  'BOOKED',
  'SURVEYED',
  'DESIGN_APPROVED',
  'READY_TO_INSTALL',
  'INSTALLED',
  'COMMISSIONED',
  'HANDED_OVER',
];

export async function transitionStage(
  db: DbOrTx,
  actor: ServiceActor,
  projectId: string,
  to: Stage,
  reason?: string,
): Promise<TransitionOutcome> {
  authorize(actor, 'project.transition');
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    const plan = planStageTransition(await snapshotOf(tx, p), to, reason);
    if (!plan.ok) return plan;
    await tx
      .update(solarProjects)
      .set({ stage: plan.value.to, heldFromStage: plan.value.heldFromStage, updatedAt: new Date() })
      .where(eq(solarProjects.id, projectId));
    await recordEvent(tx, {
      projectId,
      type: 'stage_changed',
      actor,
      from: plan.value.from,
      to: plan.value.to,
      reason: reason?.trim() || null,
    });
    if (NOTIFY_STAGES.includes(plan.value.to)) {
      await queueCustomerMessage(tx, projectId, 'stage_changed', { stage: plan.value.to });
    }
    return { ok: true, from: plan.value.from, to: plan.value.to };
  });
}

/** Apply a workstream move inside an existing transaction (project row already locked). */
export async function applyWorkstreamTransition<W extends Workstream>(
  tx: Tx,
  actor: ServiceActor,
  p: ProjectRow,
  workstream: W,
  to: WorkstreamState<W>,
  reason?: string | null,
): Promise<TransitionOutcome> {
  const from = workstreamsOf(p)[workstream] as WorkstreamState<W>;
  const plan = planWorkstreamTransition(workstream, from, to);
  if (!plan.ok) return plan;
  const column = WORKSTREAM_COLUMNS[workstream];
  await tx
    .update(solarProjects)
    .set({ [column]: to, updatedAt: new Date() })
    .where(eq(solarProjects.id, p.id));
  (p as Record<string, unknown>)[column] = to;
  await recordEvent(tx, {
    projectId: p.id,
    type: 'workstream_changed',
    actor,
    from,
    to,
    reason: reason ?? null,
    payload: { workstream },
  });
  return { ok: true, from, to };
}

export async function transitionWorkstream<W extends Workstream>(
  db: DbOrTx,
  actor: ServiceActor,
  projectId: string,
  workstream: W,
  to: WorkstreamState<W>,
  reason?: string,
): Promise<TransitionOutcome> {
  authorize(actor, 'workstream.transition');
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    return applyWorkstreamTransition(tx, actor, p, workstream, to, reason?.trim() || null);
  });
}

/**
 * Record a fact. Users may only record facts their role is allowed to attest,
 * and must leave a note (the evidence trail for concierge-mode attestations).
 */
export async function recordFact(
  db: DbOrTx,
  actor: ServiceActor,
  projectId: string,
  fact: Fact,
  value: boolean,
  note?: string,
): Promise<void> {
  if (actor.type === 'user') {
    if (!canAttest(actor.role, fact)) {
      throw new ServiceError('FORBIDDEN', `Role ${actor.role} cannot record ${fact}.`);
    }
    if (!note?.trim()) throw new ServiceError('INVALID', 'A note is required.');
  }
  await db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    await tx.insert(projectFacts).values({
      id: newId('fact'),
      projectId,
      fact,
      value,
      source: actor.type === 'user' ? 'manual' : 'system',
      note: note?.trim() || null,
      actorType: actor.type,
      actorId: actor.id,
    });
    await recordEvent(tx, {
      projectId,
      type: 'fact_recorded',
      actor,
      to: `${fact}=${value}`,
      reason: note?.trim() || null,
      payload: { fact, value },
    });
  });
}
