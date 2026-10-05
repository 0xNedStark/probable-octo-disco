import { type Stage, stageOptions } from '@solar/domain';
import { and, asc, count, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../client';
import {
  billReadings,
  consents,
  customers,
  electricityBills,
  leads,
  projectEvents,
  projectFacts,
  solarProjects,
  tasks,
} from '../schema';
import { ServiceError } from './common';
import { snapshotOf } from './projects';

export interface ProjectListFilter {
  stage?: Stage;
  /** Matches project code, customer name or phone. */
  q?: string;
  limit?: number;
}

export async function listProjects(db: DbOrTx, filter: ProjectListFilter = {}) {
  const where: SQL[] = [];
  if (filter.stage) where.push(eq(solarProjects.stage, filter.stage));
  if (filter.q?.trim()) {
    const q = `%${filter.q.trim().replace(/[%_\\]/g, '\\$&')}%`;
    where.push(
      or(ilike(solarProjects.code, q), ilike(customers.name, q), ilike(customers.phone, q))!,
    );
  }
  const openTasks = db
    .select({
      projectId: tasks.projectId,
      open: count().as('open'),
      overdue: sql<number>`count(*) filter (where ${tasks.dueAt} < now())`
        .mapWith(Number)
        .as('overdue'),
    })
    .from(tasks)
    .where(eq(tasks.status, 'OPEN'))
    .groupBy(tasks.projectId)
    .as('open_tasks');

  return db
    .select({
      id: solarProjects.id,
      code: solarProjects.code,
      stage: solarProjects.stage,
      billState: solarProjects.billState,
      createdAt: solarProjects.createdAt,
      updatedAt: solarProjects.updatedAt,
      customerName: customers.name,
      phone: customers.phone,
      city: customers.city,
      openTasks: sql<number>`coalesce(${openTasks.open}, 0)`.mapWith(Number),
      overdueTasks: sql<number>`coalesce(${openTasks.overdue}, 0)`.mapWith(Number),
    })
    .from(solarProjects)
    .innerJoin(customers, eq(customers.id, solarProjects.customerId))
    .leftJoin(openTasks, eq(openTasks.projectId, solarProjects.id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(solarProjects.updatedAt))
    .limit(filter.limit ?? 100);
}

export async function getProjectDetail(db: DbOrTx, projectId: string) {
  const [row] = await db
    .select({ project: solarProjects, customer: customers, lead: leads })
    .from(solarProjects)
    .innerJoin(customers, eq(customers.id, solarProjects.customerId))
    .leftJoin(leads, eq(leads.id, solarProjects.leadId))
    .where(eq(solarProjects.id, projectId));
  if (!row) throw new ServiceError('NOT_FOUND', 'Project not found.');

  const [snapshot, bills, readings, events, factLog, projectTasks, customerConsents] =
    await Promise.all([
      snapshotOf(db, row.project),
      db
        .select()
        .from(electricityBills)
        .where(eq(electricityBills.projectId, projectId))
        .orderBy(desc(electricityBills.uploadedAt)),
      db
        .select()
        .from(billReadings)
        .where(eq(billReadings.projectId, projectId))
        .orderBy(desc(billReadings.createdAt)),
      db
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, projectId))
        .orderBy(desc(projectEvents.createdAt), desc(projectEvents.id)),
      db
        .select()
        .from(projectFacts)
        .where(eq(projectFacts.projectId, projectId))
        .orderBy(desc(projectFacts.createdAt)),
      db
        .select()
        .from(tasks)
        .where(eq(tasks.projectId, projectId))
        .orderBy(asc(tasks.status), asc(tasks.dueAt)),
      db.select().from(consents).where(eq(consents.customerId, row.customer.id)),
    ]);

  return {
    ...row,
    snapshot,
    options: stageOptions(snapshot),
    bills,
    readings,
    events,
    factLog,
    tasks: projectTasks,
    consents: customerConsents,
  };
}

export type ProjectDetail = Awaited<ReturnType<typeof getProjectDetail>>;

/** The parts of the Appendix B dashboard answerable from week-2 data. */
export async function dashboardSummary(db: DbOrTx, now = new Date()) {
  // "Today" in India Standard Time.
  const istOffsetMs = 330 * 60_000;
  const istMidnight = new Date(
    Math.floor((now.getTime() + istOffsetMs) / 86_400_000) * 86_400_000 - istOffsetMs,
  );

  const [[leadsToday], [overdue], byStage, onHold] = await Promise.all([
    db.select({ n: count() }).from(leads).where(gte(leads.createdAt, istMidnight)),
    db
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.status, 'OPEN'), lt(tasks.dueAt, now))),
    db
      .select({ stage: solarProjects.stage, n: count() })
      .from(solarProjects)
      .groupBy(solarProjects.stage),
    db
      .select({ id: solarProjects.id, code: solarProjects.code, customerName: customers.name })
      .from(solarProjects)
      .innerJoin(customers, eq(customers.id, solarProjects.customerId))
      .where(eq(solarProjects.stage, 'ON_HOLD'))
      .limit(20),
  ]);

  return {
    leadsToday: leadsToday?.n ?? 0,
    overdueTasks: overdue?.n ?? 0,
    byStage: Object.fromEntries(byStage.map((r) => [r.stage, r.n])) as Partial<
      Record<Stage, number>
    >,
    onHold,
  };
}
