import { newId } from '@solar/domain';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../client';
import { loanApplications, solarQuotes } from '../schema';
import { authorize, ServiceError, SYSTEM, type ServiceActor } from './common';
import { activeConfig } from './config';
import { createTask } from './leads';
import {
  applyWorkstreamTransition,
  lockProject,
  queueCustomerMessage,
  recordEvent,
  recordFact,
} from './projects';

export type LoanRow = typeof loanApplications.$inferSelect;

export async function listLoans(db: DbOrTx, projectId: string): Promise<LoanRow[]> {
  return db
    .select()
    .from(loanApplications)
    .where(eq(loanApplications.projectId, projectId))
    .orderBy(desc(loanApplications.createdAt));
}

async function failOnTransition(r: { ok: boolean; error?: { message: string } }) {
  if (!r.ok)
    throw new ServiceError(
      'CONFLICT',
      r.error?.message ?? 'Finance status cannot change from here.',
    );
}

/**
 * Choose how the customer pays: cash, or a loan product from the accepted quote.
 * A loan creates an application tracked here; the customer applies to the bank.
 */
export async function chooseFinancePath(
  db: DbOrTx,
  actor: ServiceActor,
  projectId: string,
  path: 'cash' | { productId: string },
): Promise<LoanRow | null> {
  authorize(actor, 'finance.manage');
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    const open = await tx
      .select()
      .from(loanApplications)
      .where(
        and(
          eq(loanApplications.projectId, projectId),
          inArray(loanApplications.status, ['DOCS_PENDING', 'SUBMITTED', 'SANCTIONED']),
        ),
      );
    if (open.length)
      throw new ServiceError('CONFLICT', 'Withdraw the open loan application first.');

    if (path === 'cash') {
      await failOnTransition(
        await applyWorkstreamTransition(
          tx,
          actor,
          p,
          'finance',
          'NOT_REQUIRED',
          'customer pays in cash',
        ),
      );
      return null;
    }
    const [quote] = await tx
      .select()
      .from(solarQuotes)
      .where(and(eq(solarQuotes.projectId, projectId), eq(solarQuotes.status, 'ACCEPTED')))
      .orderBy(desc(solarQuotes.version))
      .limit(1);
    if (!quote) throw new ServiceError('CONFLICT', 'The customer has not accepted a quote yet.');
    const option = quote.output.finance.find((f) => f.id === path.productId);
    if (!option || option.loanPaise <= 0)
      throw new ServiceError(
        'INVALID',
        'That loan product is not an option on the accepted quote.',
      );
    const product = (await activeConfig(tx)).bundle.lenders.products.find(
      (x) => x.id === path.productId,
    );
    if (!product) throw new ServiceError('INVALID', 'Unknown loan product.');

    if (p.financeState !== 'DOCS_PENDING') {
      await failOnTransition(
        await applyWorkstreamTransition(
          tx,
          actor,
          p,
          'finance',
          'DOCS_PENDING',
          `loan: ${product.label}`,
        ),
      );
    }
    const [loan] = (await tx
      .insert(loanApplications)
      .values({
        id: newId('loan'),
        projectId,
        lender: product.lender,
        productId: product.id,
        requestedPaise: option.loanPaise,
        checklist: Object.fromEntries(product.documents.map((d) => [d, false])),
        createdBy: actor.type === 'user' ? actor.id : null,
      })
      .returning()) as [LoanRow];
    await recordEvent(tx, {
      projectId,
      type: 'loan_started',
      actor,
      to: product.id,
      payload: { loanId: loan.id, requestedPaise: option.loanPaise },
    });
    await createTask(tx, 'loan_follow_up', projectId, {
      title: `Help customer apply: ${product.label}`,
    });
    return loan;
  });
}

export type LoanUpdate =
  | { action: 'checklist'; item: string; ready: boolean }
  | { action: 'submit'; externalRef: string }
  | { action: 'sanction'; amountPaise: number; note?: string }
  | { action: 'reject'; reason: string }
  | { action: 'disburse'; amountPaise: number }
  | { action: 'withdraw'; reason: string };

/** Advance a loan application; each step moves the finance workstream with it. */
export async function updateLoan(
  db: DbOrTx,
  actor: ServiceActor,
  loanId: string,
  u: LoanUpdate,
): Promise<LoanRow> {
  authorize(actor, 'finance.manage');
  return db.transaction(async (tx) => {
    const [loan0] = await tx.select().from(loanApplications).where(eq(loanApplications.id, loanId));
    if (!loan0) throw new ServiceError('NOT_FOUND', 'Loan application not found.');
    const p = await lockProject(tx, loan0.projectId);
    const [loan] = (await tx
      .select()
      .from(loanApplications)
      .where(eq(loanApplications.id, loanId))
      .for('update')) as [LoanRow];
    const set = (values: Partial<LoanRow>) =>
      tx
        .update(loanApplications)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(loanApplications.id, loanId))
        .returning();
    const requireStatus = (...s: LoanRow['status'][]) => {
      if (!s.includes(loan.status))
        throw new ServiceError(
          'CONFLICT',
          `Loan is ${loan.status.toLowerCase().replace('_', ' ')}.`,
        );
    };
    const event = (to: string, reason?: string, payload: Record<string, unknown> = {}) =>
      recordEvent(tx, {
        projectId: loan.projectId,
        type: 'loan_updated',
        actor,
        to,
        reason: reason ?? null,
        payload: { loanId, ...payload },
      });
    const fundsSecuredOn = (await activeConfig(tx)).bundle.commercial.fundsSecuredOn;
    let updated: LoanRow[];

    switch (u.action) {
      case 'checklist': {
        if (!(u.item in loan.checklist))
          throw new ServiceError('INVALID', 'Unknown checklist item.');
        updated = await set({ checklist: { ...loan.checklist, [u.item]: u.ready } });
        return updated[0]!;
      }
      case 'submit': {
        requireStatus('DOCS_PENDING');
        if (!u.externalRef.trim())
          throw new ServiceError('INVALID', 'Enter the bank / JanSamarth application reference.');
        await failOnTransition(
          await applyWorkstreamTransition(
            tx,
            actor,
            p,
            'finance',
            'SUBMITTED',
            u.externalRef.trim(),
          ),
        );
        updated = await set({ status: 'SUBMITTED', externalRef: u.externalRef.trim() });
        await event('SUBMITTED', u.externalRef.trim());
        await notify(tx, loan.projectId, 'SUBMITTED');
        break;
      }
      case 'sanction': {
        requireStatus('SUBMITTED');
        positive(u.amountPaise);
        await failOnTransition(
          await applyWorkstreamTransition(tx, actor, p, 'finance', 'SANCTIONED', u.note ?? null),
        );
        updated = await set({
          status: 'SANCTIONED',
          sanctionedPaise: u.amountPaise,
          note: u.note ?? loan.note,
        });
        await event('SANCTIONED', u.note, { sanctionedPaise: u.amountPaise });
        if (fundsSecuredOn === 'sanction')
          await recordFact(
            tx,
            SYSTEM,
            loan.projectId,
            'funds_secured',
            true,
            `Loan sanctioned (${loanId})`,
          );
        await notify(tx, loan.projectId, 'SANCTIONED');
        break;
      }
      case 'reject': {
        requireStatus('SUBMITTED', 'DOCS_PENDING');
        if (!u.reason.trim()) throw new ServiceError('INVALID', 'Record the bank’s reason.');
        if (p.financeState === 'DOCS_PENDING') {
          await failOnTransition(
            await applyWorkstreamTransition(
              tx,
              actor,
              p,
              'finance',
              'SUBMITTED',
              'rejected before formal submission',
            ),
          );
        }
        await failOnTransition(
          await applyWorkstreamTransition(tx, actor, p, 'finance', 'REJECTED', u.reason.trim()),
        );
        updated = await set({ status: 'REJECTED', note: u.reason.trim() });
        await event('REJECTED', u.reason.trim());
        // PLAN §3C: a rejected loan entitles the customer to a full refund; someone must talk to them.
        await createTask(tx, 'loan_follow_up', loan.projectId, {
          title: 'Loan rejected: discuss cash, another lender, or refund',
        });
        await notify(tx, loan.projectId, 'REJECTED');
        break;
      }
      case 'disburse': {
        requireStatus('SANCTIONED');
        positive(u.amountPaise);
        await failOnTransition(
          await applyWorkstreamTransition(tx, actor, p, 'finance', 'DISBURSED', null),
        );
        updated = await set({ status: 'DISBURSED', disbursedPaise: u.amountPaise });
        await event('DISBURSED', undefined, { disbursedPaise: u.amountPaise });
        if (fundsSecuredOn === 'disbursement')
          await recordFact(
            tx,
            SYSTEM,
            loan.projectId,
            'funds_secured',
            true,
            `Loan disbursed (${loanId})`,
          );
        break;
      }
      case 'withdraw': {
        requireStatus('DOCS_PENDING', 'SUBMITTED');
        if (!u.reason.trim())
          throw new ServiceError('INVALID', 'Say why the application is withdrawn.');
        if (p.financeState === 'SUBMITTED') {
          await failOnTransition(
            await applyWorkstreamTransition(
              tx,
              actor,
              p,
              'finance',
              'DOCS_PENDING',
              'application withdrawn',
            ),
          );
        }
        updated = await set({ status: 'WITHDRAWN', note: u.reason.trim() });
        await event('WITHDRAWN', u.reason.trim());
        break;
      }
    }
    return updated[0]!;
  });
}

function positive(paise: number) {
  if (!Number.isInteger(paise) || paise <= 0)
    throw new ServiceError('INVALID', 'Amount must be positive.');
}

async function notify(tx: Tx, projectId: string, status: string) {
  await queueCustomerMessage(tx, projectId, 'loan_status', { status });
}
