import {
  CUSTOMER_STEPS,
  FINANCE_COPY,
  isMainStage,
  newId,
  normaliseIndianMobile,
  REGULATORY_COPY,
  SIDE_STAGE_COPY,
} from '@solar/domain';
import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../client';
import {
  consents,
  customers,
  loanApplications,
  messages,
  outbox,
  payments,
  solarProjects,
  solarQuotes,
} from '../schema';
import { authorize, ServiceError, SYSTEM, type ServiceActor } from './common';
import { createLead } from './leads';
import { queueJob, recordEvent } from './projects';

export type MessageRow = typeof messages.$inferSelect;

/** WhatsApp only allows free-form replies within 24 hours of the customer's last message. */
export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const STOP_WORDS = /^\s*(stop|unsubscribe|band karo|बंद)\s*$/i;

export interface InboundInput {
  providerMessageId: string;
  from: string;
  profileName: string | null;
  kind: 'text' | 'image' | 'document' | 'other';
  text: string | null;
  mediaId: string | null;
  mimeType: string | null;
}

async function openProjectFor(db: DbOrTx, customerId: string) {
  const [p] = await db
    .select({ id: solarProjects.id })
    .from(solarProjects)
    .where(
      and(
        eq(solarProjects.customerId, customerId),
        notInArray(solarProjects.stage, ['CLOSED', 'CANCELLED', 'LOST']),
      ),
    )
    .orderBy(desc(solarProjects.createdAt))
    .limit(1);
  return p?.id ?? null;
}

/**
 * Record an inbound WhatsApp message exactly once and queue follow-up work:
 * media → bill intake, text → Sales Agent (or a human). An unknown number
 * becomes a lead; messaging us first counts as consent to reply on WhatsApp.
 */
export async function recordInbound(
  db: DbOrTx,
  m: InboundInput,
): Promise<{ messageId: string; projectId: string | null; duplicate: boolean; optedOut: boolean }> {
  const phone = normaliseIndianMobile(m.from);
  if (!phone) throw new ServiceError('INVALID', `Unsupported number ${m.from}`);

  const [existing] = await db
    .select()
    .from(messages)
    .where(eq(messages.providerMessageId, m.providerMessageId));
  if (existing)
    return {
      messageId: existing.id,
      projectId: existing.projectId,
      duplicate: true,
      optedOut: false,
    };

  let [customer] = await db.select().from(customers).where(eq(customers.phone, phone));
  if (!customer && !(m.text && STOP_WORDS.test(m.text))) {
    await createLead(db, {
      name: m.profileName?.trim() || 'WhatsApp customer',
      phone,
      city: 'Unknown',
      source: 'whatsapp',
      consent: {
        contact: true,
        whatsapp: true,
        textVersion: 'whatsapp-inbound-v1',
        channel: 'whatsapp',
      },
    });
    [customer] = await db.select().from(customers).where(eq(customers.phone, phone));
  }

  return db.transaction(async (tx) => {
    const projectId = customer ? await openProjectFor(tx, customer.id) : null;
    const id = newId('message');
    const inserted = await tx
      .insert(messages)
      .values({
        id,
        projectId,
        customerId: customer?.id ?? null,
        channel: 'whatsapp',
        direction: 'in',
        providerMessageId: m.providerMessageId,
        phone,
        kind: m.kind,
        body: m.text,
        mediaId: m.mediaId,
        mediaMimeType: m.mimeType,
        author: 'customer',
      })
      .onConflictDoNothing({ target: messages.providerMessageId })
      .returning({ id: messages.id });
    if (!inserted.length) return { messageId: id, projectId, duplicate: true, optedOut: false };

    if (m.text && STOP_WORDS.test(m.text)) {
      if (customer) {
        await tx
          .update(consents)
          .set({ withdrawnAt: new Date() })
          .where(
            and(
              eq(consents.customerId, customer.id),
              eq(consents.purpose, 'whatsapp'),
              isNull(consents.withdrawnAt),
            ),
          );
        if (projectId)
          await recordEvent(tx, {
            projectId,
            type: 'whatsapp_opt_out',
            actor: SYSTEM,
            reason: m.text,
          });
      }
      return { messageId: id, projectId, duplicate: false, optedOut: true };
    }

    if ((m.kind === 'image' || m.kind === 'document') && m.mediaId && projectId) {
      await queueJob(tx, projectId, 'whatsapp.media', { messageId: id });
    } else if (m.kind === 'text' && projectId) {
      await queueJob(tx, projectId, 'sales_agent.reply', { messageId: id });
    }
    return { messageId: id, projectId, duplicate: false, optedOut: false };
  });
}

/** Called by the worker after a WhatsApp send, so the conversation shows what went out. */
export async function recordOutbound(
  db: DbOrTx,
  o: {
    outboxId: string;
    projectId: string | null;
    phone: string;
    template: string;
    rendered: string;
    providerMessageId: string | null;
    author: string | null;
    authorId: string | null;
  },
): Promise<void> {
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.phone, o.phone));
  await db
    .insert(messages)
    .values({
      id: newId('message'),
      projectId: o.projectId,
      customerId: customer?.id ?? null,
      channel: 'whatsapp',
      direction: 'out',
      providerMessageId: o.providerMessageId,
      phone: o.phone,
      kind: o.template === 'reply' ? 'text' : 'template',
      body: o.rendered,
      author: o.author ?? 'system',
      authorId: o.authorId,
      outboxId: o.outboxId,
    })
    .onConflictDoNothing();
}

export async function getMessage(db: DbOrTx, id: string): Promise<MessageRow | null> {
  const [m] = await db.select().from(messages).where(eq(messages.id, id));
  return m ?? null;
}

export async function conversation(db: DbOrTx, phone: string, limit = 30): Promise<MessageRow[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.phone, phone))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);
  return rows.reverse();
}

export async function lastInboundAt(db: DbOrTx, phone: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.phone, phone), eq(messages.direction, 'in')))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row?.at ?? null;
}

/** Queue a free-form WhatsApp reply (inside the 24-hour session window only). */
export async function queueReply(
  db: DbOrTx,
  author: { kind: 'staff' | 'agent'; id: string },
  projectId: string,
  text: string,
): Promise<void> {
  if (!text.trim()) throw new ServiceError('INVALID', 'Write a message.');
  const [row] = await db
    .select({ phone: customers.phone })
    .from(solarProjects)
    .innerJoin(customers, eq(customers.id, solarProjects.customerId))
    .where(eq(solarProjects.id, projectId));
  if (!row) throw new ServiceError('NOT_FOUND', 'Project not found.');
  const last = await lastInboundAt(db, row.phone);
  if (!last || Date.now() - last.getTime() > SESSION_WINDOW_MS) {
    throw new ServiceError(
      'CONFLICT',
      'Outside WhatsApp’s 24-hour reply window. Call the customer or send a template message.',
    );
  }
  await db.insert(outbox).values({
    id: newId('outbox'),
    projectId,
    channel: 'whatsapp',
    template: 'reply',
    recipient: row.phone,
    payload: { text: text.trim().slice(0, 4096), author: author.kind, authorId: author.id },
  });
}

export async function sendStaffReply(
  db: DbOrTx,
  actor: ServiceActor,
  projectId: string,
  text: string,
): Promise<void> {
  authorize(actor, 'message.send');
  await db.transaction(async (tx) => {
    await queueReply(tx, { kind: 'staff', id: actor.id }, projectId, text);
    await recordEvent(tx, {
      projectId,
      type: 'whatsapp_reply_queued',
      actor,
      reason: text.trim().slice(0, 200),
    });
  });
}

/**
 * The only facts the Sales Agent may state. Everything here comes from stored,
 * customer-safe data; the agent's numbers are checked against this object.
 */
export async function customerFacts(
  db: DbOrTx,
  projectId: string,
  links: { statusUrl: string | null; privacyUrl: string | null },
) {
  const [row] = await db
    .select({ project: solarProjects, customer: customers })
    .from(solarProjects)
    .innerJoin(customers, eq(customers.id, solarProjects.customerId))
    .where(eq(solarProjects.id, projectId));
  if (!row) throw new ServiceError('NOT_FOUND', 'Project not found.');
  const p = row.project;
  const stage = isMainStage(p.stage) ? CUSTOMER_STEPS.find((s) => s.stage === p.stage) : null;
  const [quote] = await db
    .select()
    .from(solarQuotes)
    .where(
      and(eq(solarQuotes.projectId, projectId), inArray(solarQuotes.status, ['SENT', 'ACCEPTED'])),
    )
    .orderBy(desc(solarQuotes.version))
    .limit(1);
  const [paid] = await db
    .select({ total: sql<number>`coalesce(sum(${payments.amountPaise}), 0)`.mapWith(Number) })
    .from(payments)
    .where(and(eq(payments.projectId, projectId), eq(payments.status, 'PAID')));
  const [loan] = await db
    .select()
    .from(loanApplications)
    .where(eq(loanApplications.projectId, projectId))
    .orderBy(desc(loanApplications.createdAt))
    .limit(1);
  const r = (paise: number) => Math.round(paise / 100);
  const o = quote?.output;

  return {
    customerFirstName: row.customer.name.split(/\s+/)[0],
    projectCode: p.code,
    status: stage
      ? { title: stage.title, nextStep: stage.next }
      : { title: SIDE_STAGE_COPY[p.stage] ?? p.stage, nextStep: null },
    billReceived: p.billState !== 'NOT_RECEIVED',
    billNeedsClearerCopy: p.billState === 'NEEDS_RESUBMIT',
    proposal: o
      ? {
          status: quote!.status === 'ACCEPTED' ? 'accepted' : 'sent, awaiting customer decision',
          systemKw: o.system.kw,
          priceInclGstRupees: r(o.price.totalPaise),
          subsidyRupees: r(o.subsidy.totalPaise),
          subsidyPaidTo:
            o.subsidy.recipient === 'customer'
              ? "customer's bank account after DVVNL commissioning"
              : 'vendor',
          costAfterSubsidyRupees: r(o.netCostAfterSubsidyPaise),
          estimatedYear1SavingsRupees: r(o.savings.year1SavingsPaise),
          estimatedPaybackYears: o.savings.paybackYears,
          paymentOptions: o.finance.map((f) => ({
            option: f.label,
            payUpfrontRupees: r(f.payNowPaise),
            loanRupees: r(f.loanPaise),
            monthlyEmiRupees: f.emiPaise != null ? r(f.emiPaise) : null,
            illustrative: f.illustrative,
          })),
          validUntil: quote!.validUntil,
        }
      : null,
    paymentsReceivedRupees: r(paid?.total ?? 0),
    finance: FINANCE_COPY[p.financeState] ?? null,
    loanDocumentsStillNeeded:
      loan && loan.status === 'DOCS_PENDING'
        ? Object.entries(loan.checklist)
            .filter(([, ok]) => !ok)
            .map(([d]) => d)
        : [],
    dvvnlProgress: REGULATORY_COPY[p.regulatoryState] ?? null,
    installationDate: null as string | null,
    statusPageUrl: links.statusUrl,
    privacyNoticeUrl: links.privacyUrl,
  };
}

export type CustomerFacts = Awaited<ReturnType<typeof customerFacts>>;
