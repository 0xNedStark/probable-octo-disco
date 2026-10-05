import { and, asc, eq, isNull, or, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../client';
import { customers, solarProjects, tasks } from '../schema';
import { authorize, ServiceError, type ServiceActor } from './common';
import { recordEvent } from './projects';

export interface TaskFilter {
  status?: 'OPEN' | 'DONE';
  /** Only tasks assigned to this user or unassigned. */
  forUserId?: string;
  projectId?: string;
}

export async function listTasks(db: DbOrTx, filter: TaskFilter = {}) {
  const where: SQL[] = [eq(tasks.status, filter.status ?? 'OPEN')];
  if (filter.projectId) where.push(eq(tasks.projectId, filter.projectId));
  if (filter.forUserId) {
    where.push(or(eq(tasks.assigneeUserId, filter.forUserId), isNull(tasks.assigneeUserId))!);
  }
  return db
    .select({
      task: tasks,
      projectCode: solarProjects.code,
      customerName: customers.name,
    })
    .from(tasks)
    .leftJoin(solarProjects, eq(solarProjects.id, tasks.projectId))
    .leftJoin(customers, eq(customers.id, solarProjects.customerId))
    .where(and(...where))
    .orderBy(asc(tasks.dueAt))
    .limit(200);
}

export async function assignTask(
  db: DbOrTx,
  actor: ServiceActor,
  taskId: string,
  userId: string | null,
): Promise<void> {
  authorize(actor, 'task.work');
  const rows = await db
    .update(tasks)
    .set({ assigneeUserId: userId })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'OPEN')))
    .returning({ id: tasks.id });
  if (!rows.length) throw new ServiceError('NOT_FOUND', 'Open task not found.');
}

/** Effort minutes are required: they are the source of the ops-hours-per-project metric. */
export async function completeTask(
  db: DbOrTx,
  actor: ServiceActor,
  taskId: string,
  effortMinutes: number,
  outcome: string,
): Promise<void> {
  authorize(actor, 'task.work');
  if (actor.type !== 'user') throw new ServiceError('FORBIDDEN', 'Only staff complete tasks.');
  if (!Number.isInteger(effortMinutes) || effortMinutes < 0 || effortMinutes > 8 * 60) {
    throw new ServiceError('INVALID', 'Effort must be 0–480 minutes.');
  }
  await db.transaction(async (tx) => {
    const [t] = await tx
      .update(tasks)
      .set({
        status: 'DONE',
        completedAt: new Date(),
        completedBy: actor.id,
        effortMinutes,
        outcome: outcome.trim() || null,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, 'OPEN')))
      .returning();
    if (!t) throw new ServiceError('NOT_FOUND', 'Open task not found.');
    if (t.projectId) {
      await recordEvent(tx, {
        projectId: t.projectId,
        type: 'task_completed',
        actor,
        to: t.type,
        reason: t.outcome,
        payload: { taskId: t.id, effortMinutes },
      });
    }
  });
}
