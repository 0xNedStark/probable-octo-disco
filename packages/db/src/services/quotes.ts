import {
  calculate,
  CALC_VERSION,
  CalcError,
  canonicalJson,
  sha256Hex,
  type CalcInput,
  type CalcOutput,
} from '@solar/calc';
import { newId } from '@solar/domain';
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, max } from 'drizzle-orm';
import type { DbOrTx } from '../client';
import {
  billReadings,
  customers,
  projectEvents,
  solarProjects,
  solarQuotes,
  type QuoteGrade,
} from '../schema';
import { authorize, ServiceError, SYSTEM, type ServiceActor } from './common';
import { activeConfig, configByIds } from './config';
import { createTask } from './leads';
import { lockProject, queueCustomerMessage, recordEvent, recordFact } from './projects';

export type QuoteRow = typeof solarQuotes.$inferSelect;

export interface GenerateQuoteOptions {
  grade: QuoteGrade;
  tariffCategory?: string;
  roofAreaM2?: number;
  targetOffset?: number;
  packageId?: string;
}

const QUOTE_VALIDITY_DAYS = 15;

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** The latest human-confirmed bill reading, which is the only valid basis for a quote. */
export async function confirmedReading(db: DbOrTx, projectId: string) {
  const [row] = await db
    .select()
    .from(billReadings)
    .where(and(eq(billReadings.projectId, projectId), eq(billReadings.status, 'confirmed')))
    .orderBy(desc(billReadings.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Compute and store a new quote version from the confirmed bill and the active
 * configuration. Earlier unaccepted quotes of the same grade are superseded.
 */
export async function generateQuote(
  db: DbOrTx,
  actor: ServiceActor,
  projectId: string,
  opts: GenerateQuoteOptions,
): Promise<QuoteRow> {
  authorize(actor, 'quote.manage');
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    const reading = await confirmedReading(tx, projectId);
    if (!reading)
      throw new ServiceError('CONFLICT', 'Confirm the bill readings before generating a quote.');
    const [customer] = await tx.select().from(customers).where(eq(customers.id, p.customerId));
    const config = await activeConfig(tx);

    const tariffCategory =
      opts.tariffCategory ??
      (config.bundle.tariff.categories[reading.tariffCategory]
        ? reading.tariffCategory
        : config.bundle.tariff.defaultCategory);
    const billMonth = reading.periodEnd.slice(0, 7);
    const usage = [
      ...reading.monthlyHistory.filter((m) => m.month !== billMonth),
      { month: billMonth, units: reading.unitsKwh },
    ];
    const input: CalcInput = {
      grade: opts.grade,
      city: customer!.city,
      tariffCategory,
      sanctionedLoadKw: reading.sanctionedLoadW / 1000,
      monthlyUsage: usage,
      ...(opts.roofAreaM2 != null ? { roofAreaM2: opts.roofAreaM2 } : {}),
      ...(opts.targetOffset != null ? { targetOffset: opts.targetOffset } : {}),
      ...(opts.packageId ? { packageId: opts.packageId } : {}),
    };

    let output: CalcOutput;
    try {
      output = calculate(input, config.bundle, config.labels);
    } catch (e) {
      if (e instanceof CalcError) throw new ServiceError('INVALID', e.message);
      throw e;
    }

    const [{ v } = { v: 0 }] = await tx
      .select({ v: max(solarQuotes.version) })
      .from(solarQuotes)
      .where(eq(solarQuotes.projectId, projectId));
    const version = (v ?? 0) + 1;

    await tx
      .update(solarQuotes)
      .set({ status: 'SUPERSEDED' })
      .where(
        and(
          eq(solarQuotes.projectId, projectId),
          eq(solarQuotes.grade, opts.grade),
          inArray(solarQuotes.status, ['DRAFT', 'SENT']),
        ),
      );

    const validUntil = new Date(Date.now() + QUOTE_VALIDITY_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const pbValid = config.bundle.pricebook.validUntil;
    const [quote] = await tx
      .insert(solarQuotes)
      .values({
        id: newId('quote'),
        projectId,
        version,
        grade: opts.grade,
        calcVersion: CALC_VERSION,
        configVersionIds: config.ids,
        configHash: config.hash,
        input,
        output,
        outputHash: sha256Hex(canonicalJson(output)),
        systemKw: String(output.system.kw),
        totalPaise: output.price.totalPaise,
        validUntil: pbValid < validUntil ? pbValid : validUntil,
        createdBy: actor.type === 'user' ? actor.id : null,
      })
      .returning();

    await recordEvent(tx, {
      projectId,
      type: 'quote_generated',
      actor,
      to: `v${version} ${opts.grade} ${output.system.kw} kW`,
      payload: { quoteId: quote!.id, configHash: config.hash, flags: output.flags },
    });
    return quote!;
  });
}

export async function listQuotes(db: DbOrTx, projectId: string): Promise<QuoteRow[]> {
  return db
    .select()
    .from(solarQuotes)
    .where(eq(solarQuotes.projectId, projectId))
    .orderBy(desc(solarQuotes.version));
}

export async function getQuote(db: DbOrTx, quoteId: string): Promise<QuoteRow> {
  const [q] = await db.select().from(solarQuotes).where(eq(solarQuotes.id, quoteId));
  if (!q) throw new ServiceError('NOT_FOUND', 'Quote not found.');
  return q;
}

async function lockQuote(db: DbOrTx, quoteId: string): Promise<QuoteRow> {
  const [q] = await db.select().from(solarQuotes).where(eq(solarQuotes.id, quoteId)).for('update');
  if (!q) throw new ServiceError('NOT_FOUND', 'Quote not found.');
  return q;
}

/** Reasons a quote may not be shown to a customer yet; empty when sendable. */
export function sendBlockers(q: QuoteRow, today = new Date().toISOString().slice(0, 10)): string[] {
  const out: string[] = [];
  if (q.status !== 'DRAFT') out.push(`Quote is ${q.status.toLowerCase()}.`);
  if (q.output.flags.includes('placeholder_prices')) {
    out.push('The price book is still a placeholder — publish real supplier prices first.');
  }
  if (q.validUntil < today) out.push('Quote has expired; generate a new one.');
  return out;
}

/**
 * Mark a quote as sent and create the customer's private link. Returns the raw
 * token once; only its hash is stored.
 */
export async function sendQuote(
  db: DbOrTx,
  actor: ServiceActor,
  quoteId: string,
  publicBaseUrl: string,
): Promise<{ token: string; url: string }> {
  authorize(actor, 'quote.manage');
  return db.transaction(async (tx) => {
    const q0 = await getQuote(tx, quoteId);
    await lockProject(tx, q0.projectId);
    const q = await lockQuote(tx, quoteId);
    const blockers = sendBlockers(q);
    if (blockers.length) throw new ServiceError('CONFLICT', blockers.join(' '));

    const token = randomBytes(24).toString('base64url');
    const url = `${publicBaseUrl.replace(/\/$/, '')}/p/${token}`;
    await tx
      .update(solarQuotes)
      .set({ status: 'SENT', sentAt: new Date(), shareTokenHash: hashToken(token) })
      .where(eq(solarQuotes.id, quoteId));
    await recordEvent(tx, {
      projectId: q.projectId,
      type: 'quote_sent',
      actor,
      to: `v${q.version}`,
      payload: { quoteId },
    });
    if (q.grade === 'INDICATIVE') {
      await recordFact(tx, SYSTEM, q.projectId, 'quote_sent', true, `Quote v${q.version} sent`);
    }
    await queueCustomerMessage(tx, q.projectId, 'quote_sent', {
      url,
      systemKw: q.output.system.kw,
      totalPaise: q.output.price.totalPaise,
      subsidyPaise: q.output.subsidy.totalPaise,
    });
    await createTask(tx, 'quote_follow_up', q.projectId, {
      title: `Follow up on quote v${q.version}`,
    });
    return { token, url };
  });
}

/** Ops records that the customer accepted (by phone/WhatsApp) until click-wrap acceptance ships. */
export async function acceptQuote(
  db: DbOrTx,
  actor: ServiceActor,
  quoteId: string,
  note: string,
): Promise<void> {
  authorize(actor, 'quote.manage');
  if (!note.trim()) throw new ServiceError('INVALID', 'Note how the customer confirmed.');
  await db.transaction(async (tx) => {
    const q0 = await getQuote(tx, quoteId);
    await lockProject(tx, q0.projectId);
    const q = await lockQuote(tx, quoteId);
    if (q.status !== 'SENT')
      throw new ServiceError('CONFLICT', 'Only a sent quote can be accepted.');
    await tx
      .update(solarQuotes)
      .set({ status: 'ACCEPTED', acceptedAt: new Date() })
      .where(eq(solarQuotes.id, quoteId));
    await recordEvent(tx, {
      projectId: q.projectId,
      type: 'quote_accepted',
      actor,
      to: `v${q.version}`,
      reason: note.trim(),
      payload: { quoteId },
    });
    const fact = q.grade === 'INDICATIVE' ? 'quote_accepted_indicative' : 'quote_accepted_final';
    await recordFact(tx, actor, q.projectId, fact, true, `Quote v${q.version}: ${note.trim()}`);
  });
}

export interface ReproduceResult {
  reproducible: boolean;
  matches: boolean;
  reason: string | null;
}

/** Recompute a stored quote from its recorded inputs and config versions. */
export async function reproduceQuote(db: DbOrTx, quoteId: string): Promise<ReproduceResult> {
  const q = await getQuote(db, quoteId);
  if (q.calcVersion !== CALC_VERSION) {
    return {
      reproducible: false,
      matches: false,
      reason: `Quote used calc ${q.calcVersion}; this build is ${CALC_VERSION}.`,
    };
  }
  const config = await configByIds(db, q.configVersionIds);
  if (config.hash !== q.configHash)
    return { reproducible: true, matches: false, reason: 'Config hash differs.' };
  const output = calculate(q.input, config.bundle, config.labels);
  const matches = sha256Hex(canonicalJson(output)) === q.outputHash;
  return { reproducible: true, matches, reason: matches ? null : 'Output differs.' };
}

/**
 * Resolve a customer proposal link. Records a view event (at most hourly) so
 * sales can see the customer opened it.
 */
export async function getQuoteByToken(db: DbOrTx, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [row] = await db
    .select({ quote: solarQuotes, customerName: customers.name, projectCode: solarProjects.code })
    .from(solarQuotes)
    .innerJoin(solarProjects, eq(solarProjects.id, solarQuotes.projectId))
    .innerJoin(customers, eq(customers.id, solarProjects.customerId))
    .where(eq(solarQuotes.shareTokenHash, hashToken(token)));
  if (!row) return null;
  const [recent] = await db
    .select({ id: projectEvents.id })
    .from(projectEvents)
    .where(
      and(
        eq(projectEvents.projectId, row.quote.projectId),
        eq(projectEvents.type, 'proposal_viewed'),
        gt(projectEvents.createdAt, new Date(Date.now() - 3_600_000)),
      ),
    )
    .limit(1);
  if (!recent) {
    await recordEvent(db, {
      projectId: row.quote.projectId,
      type: 'proposal_viewed',
      actor: { type: 'system', id: 'customer-link' },
      to: `v${row.quote.version}`,
      payload: { quoteId: row.quote.id },
    });
  }
  return { ...row, firstName: row.customerName.split(/\s+/)[0] ?? row.customerName };
}
