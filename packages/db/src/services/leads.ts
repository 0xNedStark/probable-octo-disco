import {
  type TaskType,
  initialWorkstreams,
  newId,
  normaliseIndianMobile,
  projectCode,
  TASK_TYPES,
  taskDueAt,
} from '@solar/domain';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../client';
import {
  consents,
  customers,
  electricityBills,
  leads,
  projectCodeSeq,
  solarProjects,
  tasks,
} from '../schema';
import { authorize, SYSTEM, ServiceError, type ServiceActor } from './common';
import {
  applyWorkstreamTransition,
  lockProject,
  queueCustomerMessage,
  recordEvent,
  recordFact,
} from './projects';

export interface UploadedBill {
  /** Pre-generated so the caller can store the file under this id before the DB write. */
  id: string;
  storageKey: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface CreateLeadInput {
  name: string;
  phone: string;
  city: string;
  pincode?: string;
  consumerNumber?: string;
  statedMonthlyBillRupees?: number;
  source: string;
  campaign?: string;
  referrer?: string;
  consent: { contact: boolean; whatsapp: boolean; textVersion: string; channel: string };
  bill?: UploadedBill;
}

export interface CreateLeadResult {
  projectId: string;
  projectCode: string;
  /** False when the phone already had an open project and the lead was merged into it. */
  newProject: boolean;
}

const LAUNCH_DISCOM = 'DVVNL';

export async function createTask(
  db: DbOrTx,
  type: TaskType,
  projectId: string | null,
  opts: { title?: string; now?: Date } = {},
): Promise<string> {
  const id = newId('task');
  const def = TASK_TYPES[type];
  await db.insert(tasks).values({
    id,
    projectId,
    type,
    title: opts.title ?? def.label,
    role: def.defaultRole,
    dueAt: taskDueAt(type, opts.now ?? new Date()),
  });
  return id;
}

/**
 * Capture a lead from the website (or WhatsApp later). A repeat enquiry from a
 * phone with an open project is merged into that project rather than duplicated.
 */
export async function createLead(db: DbOrTx, input: CreateLeadInput): Promise<CreateLeadResult> {
  const phone = normaliseIndianMobile(input.phone);
  if (!phone) throw new ServiceError('INVALID', 'Enter a valid 10-digit Indian mobile number.');
  if (!input.consent.contact) {
    throw new ServiceError('INVALID', 'Consent to be contacted is required.');
  }
  const name = input.name.trim();
  const city = input.city.trim();
  if (!name || !city) throw new ServiceError('INVALID', 'Name and city are required.');

  return db.transaction(async (tx) => {
    const [customer] = await tx
      .insert(customers)
      .values({
        id: newId('customer'),
        name,
        phone,
        city,
        pincode: input.pincode?.trim() || null,
        discom: LAUNCH_DISCOM,
        consumerNumber: input.consumerNumber?.trim() || null,
      })
      .onConflictDoUpdate({
        target: customers.phone,
        set: {
          name,
          city,
          pincode: sql`coalesce(excluded.pincode, ${customers.pincode})`,
          consumerNumber: sql`coalesce(excluded.consumer_number, ${customers.consumerNumber})`,
        },
      })
      .returning();
    if (!customer) throw new Error('customer upsert returned no row');

    const leadId = newId('lead');
    await tx.insert(leads).values({
      id: leadId,
      customerId: customer.id,
      source: input.source,
      campaign: input.campaign ?? null,
      referrer: input.referrer ?? null,
      statedMonthlyBillPaise:
        input.statedMonthlyBillRupees != null
          ? Math.round(input.statedMonthlyBillRupees * 100)
          : null,
    });

    await recordConsents(tx, customer.id, input.consent);

    const [existing] = await tx
      .select({ id: solarProjects.id, code: solarProjects.code })
      .from(solarProjects)
      .where(
        and(
          eq(solarProjects.customerId, customer.id),
          notInArray(solarProjects.stage, ['CLOSED', 'CANCELLED', 'LOST']),
        ),
      )
      .orderBy(desc(solarProjects.createdAt))
      .limit(1);

    let projectId: string;
    let code: string;
    const newProject = !existing;
    if (existing) {
      projectId = existing.id;
      code = existing.code;
      await recordEvent(tx, {
        projectId,
        type: 'lead_merged',
        actor: SYSTEM,
        payload: { leadId, source: input.source },
      });
    } else {
      projectId = newId('project');
      code = await nextProjectCode(tx);
      await tx.insert(solarProjects).values({
        id: projectId,
        code,
        customerId: customer.id,
        leadId,
        stage: 'LEAD',
        ...toColumns(initialWorkstreams()),
      });
      await recordEvent(tx, {
        projectId,
        type: 'lead_created',
        actor: SYSTEM,
        to: 'LEAD',
        payload: { leadId, source: input.source, campaign: input.campaign ?? null },
      });
      await createTask(tx, 'first_contact', projectId, { title: `Call ${name} (${city})` });
      await queueCustomerMessage(tx, projectId, 'lead_received', { projectCode: code });
    }

    await recordFact(tx, SYSTEM, projectId, 'contact_consent', true);
    if (input.bill) await attachBillInTx(tx, SYSTEM, projectId, customer.id, input.bill, 'web');

    return { projectId, projectCode: code, newProject };
  });
}

async function recordConsents(
  tx: Tx,
  customerId: string,
  c: CreateLeadInput['consent'],
): Promise<void> {
  const purposes = ['contact', 'privacy_notice', ...(c.whatsapp ? ['whatsapp'] : [])];
  await tx.insert(consents).values(
    purposes.map((purpose) => ({
      id: newId('consent'),
      customerId,
      purpose,
      textVersion: c.textVersion,
      channel: c.channel,
    })),
  );
}

async function nextProjectCode(tx: Tx): Promise<string> {
  const rows = await tx.execute<{ n: string }>(sql`select nextval(${projectCodeSeq.seqName}) as n`);
  const n = Number(rows[0]?.n);
  return projectCode(new Date().getUTCFullYear(), n);
}

function toColumns(w: ReturnType<typeof initialWorkstreams>) {
  return {
    billState: w.bill,
    financeState: w.finance,
    regulatoryState: w.regulatory,
    procurementState: w.procurement,
    installationState: w.installation,
  };
}

/** Attach a bill and move the bill workstream back to RECEIVED where that is a legal move. */
export async function attachBillInTx(
  tx: Tx,
  actor: ServiceActor,
  projectId: string,
  customerId: string,
  bill: UploadedBill,
  source: 'web' | 'whatsapp' | 'ops',
): Promise<void> {
  const p = await lockProject(tx, projectId);
  await tx.insert(electricityBills).values({
    id: bill.id,
    projectId,
    customerId,
    storageKey: bill.storageKey,
    originalFilename: bill.originalFilename,
    contentType: bill.contentType,
    sizeBytes: bill.sizeBytes,
    sha256: bill.sha256,
    source,
    uploadedBy: actor.type === 'user' ? actor.id : null,
  });
  await recordEvent(tx, {
    projectId,
    type: 'bill_uploaded',
    actor,
    payload: { billId: bill.id, sha256: bill.sha256, source },
  });
  // A bill already awaiting review just gains another file; otherwise review starts again.
  if (['NOT_RECEIVED', 'NEEDS_RESUBMIT', 'CONFIRMED'].includes(p.billState)) {
    await applyWorkstreamTransition(tx, actor, p, 'bill', 'RECEIVED', 'bill uploaded');
    await createTask(tx, 'bill_review', projectId);
  }
}

/** Ops uploads a bill on the customer's behalf (e.g. received on WhatsApp before the bot exists). */
export async function attachBill(
  db: DbOrTx,
  actor: ServiceActor,
  projectId: string,
  bill: UploadedBill,
): Promise<void> {
  authorize(actor, 'bill.enter_readings');
  await db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    await attachBillInTx(tx, actor, projectId, p.customerId, bill, 'ops');
  });
}
