import {
  activeConfig,
  conversation,
  customerAdvanceBalance,
  getProjectDetail,
  listLoans,
  listPayments,
  listQuotes,
  ServiceError,
  statusUrl,
} from '@solar/db';
import {
  can,
  canAttest,
  FACTS,
  STAGE_LABELS,
  TASK_TYPES,
  WORKSTREAM_NAMES,
  workstreamNext,
  type Fact,
} from '@solar/domain';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireStaff } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatDateTime, formatRupees, humanize, relativeDue } from '@/lib/format';
import { Flash } from '../../../flash';
import { StageBadge } from '../../../stage-badge';
import { attestFact, finishTask, moveStage, moveWorkstream } from './actions';
import { BillSection } from './bill-section';
import { ConversationPanel } from './conversation-panel';
import { FinancePanel } from './finance-panel';
import { PaymentsPanel } from './payments-panel';
import { QuotePanel } from './quote-panel';
import { getPaymentProvider } from '@/lib/payments';

const AI_THRESHOLD = Number(process.env.AI_BILL_CONFIDENCE_THRESHOLD ?? 0.9);

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const user = await requireStaff();
  const { id } = await params;
  const { error, ok } = await searchParams;

  let d, quotes, config, payments, balance, loans;
  try {
    [d, quotes, config, payments, balance, loans] = await Promise.all([
      getProjectDetail(getDb(), id),
      listQuotes(getDb(), id),
      activeConfig(getDb()),
      listPayments(getDb(), id),
      customerAdvanceBalance(getDb(), id),
      listLoans(getDb(), id),
    ]);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  const { project: p, customer: c, snapshot } = d;
  const canMove = can(user.role, 'project.transition');
  const canMoveWs = can(user.role, 'workstream.transition');
  const canBill = can(user.role, 'bill.enter_readings');
  const openTasks = d.tasks.filter((t) => t.status === 'OPEN');

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>
            {p.code} · {c.name}
          </h1>
          <div className="row muted small">
            <StageBadge stage={p.stage} />
            {p.heldFromStage && <span>(held from {STAGE_LABELS[p.heldFromStage]})</span>}
            <a href={`tel:${c.phone}`}>{c.phone}</a>
            <span>
              {c.city}
              {c.pincode ? ` ${c.pincode}` : ''}
            </span>
            <span>{c.discom}</span>
            {c.consumerNumber && <span>A/c {c.consumerNumber}</span>}
            {d.lead && <span>via {d.lead.source}</span>}
            {process.env.STATUS_LINK_SECRET && process.env.PUBLIC_BASE_URL && (
              <a
                href={statusUrl(p.id, process.env.PUBLIC_BASE_URL, process.env.STATUS_LINK_SECRET)}
                target="_blank"
                rel="noreferrer"
              >
                customer status page
              </a>
            )}
            {d.lead?.statedMonthlyBillPaise != null && (
              <span>says bill ≈ {formatRupees(d.lead.statedMonthlyBillPaise)}/month</span>
            )}
          </div>
        </div>
      </div>
      <Flash error={error} ok={ok} />

      <div className="grid grid-2">
        <div className="stack">
          {/* Stage moves with their gate requirements */}
          <section className="card stack">
            <h2>Move stage</h2>
            {d.options.length === 0 && <p className="muted">No further moves.</p>}
            {d.options.map((o) => {
              const blocked = o.requirements.some((r) => !r.met);
              return (
                <form
                  key={o.to}
                  action={moveStage.bind(null, p.id)}
                  className="stack"
                  style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}
                >
                  <input type="hidden" name="to" value={o.to} />
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong>→ {STAGE_LABELS[o.to]}</strong>
                    <div className="row">
                      {o.reasonRequired && (
                        <input
                          name="reason"
                          placeholder="Reason (required)"
                          required
                          style={{ width: 220 }}
                        />
                      )}
                      <button
                        type="submit"
                        className={blocked ? 'secondary' : ''}
                        disabled={!canMove || blocked}
                      >
                        Move
                      </button>
                    </div>
                  </div>
                  {o.requirements.length > 0 && (
                    <ul className="req small">
                      {o.requirements.map((r) => (
                        <li key={r.id} className={r.met ? 'met' : ''}>
                          {r.label}
                        </li>
                      ))}
                    </ul>
                  )}
                </form>
              );
            })}
          </section>

          <QuotePanel
            projectId={p.id}
            quotes={quotes}
            config={config}
            canQuote={can(user.role, 'quote.manage')}
            hasConfirmedReading={d.readings.some((r) => r.status === 'confirmed')}
          />

          <PaymentsPanel
            projectId={p.id}
            payments={payments}
            balancePaise={balance}
            canManage={can(user.role, 'payment.manage')}
            canRequest={
              can(user.role, 'quote.manage') &&
              quotes.some((q) => q.status === 'ACCEPTED' && q.grade === 'INDICATIVE') &&
              !payments.some((x) => x.purpose === 'booking_advance' && x.status === 'PAID')
            }
            gatewayConfigured={getPaymentProvider() !== null}
          />

          <FinancePanel
            projectId={p.id}
            financeState={p.financeState}
            loans={loans}
            acceptedQuote={quotes.find((q) => q.status === 'ACCEPTED') ?? null}
            canManage={can(user.role, 'finance.manage')}
          />

          <BillSection d={d} canBill={canBill} threshold={AI_THRESHOLD} />

          {/* Timeline */}
          <section className="card">
            <h2>Timeline</h2>
            <ul className="timeline small">
              {d.events.map((e) => (
                <li key={e.id}>
                  <span className="muted">{formatDateTime(e.createdAt)}</span>{' '}
                  <strong>{humanize(e.type)}</strong>
                  {e.payload.workstream ? ` (${String(e.payload.workstream)})` : ''}
                  {e.fromValue || e.toValue ? ` ${e.fromValue ?? ''} → ${e.toValue ?? ''}` : ''}
                  {e.reason && <span> — “{e.reason}”</span>}
                  <span className="muted"> · {e.actorType === 'user' ? 'staff' : e.actorType}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="stack">
          <ConversationPanel
            projectId={p.id}
            messages={await conversation(getDb(), c.phone)}
            canSend={can(user.role, 'message.send')}
          />

          {/* Tasks */}
          <section className="card stack">
            <h2>Open tasks</h2>
            {openTasks.length === 0 && <p className="muted small">None.</p>}
            {openTasks.map((t) => {
              const due = relativeDue(t.dueAt);
              return (
                <form
                  key={t.id}
                  action={finishTask.bind(null, p.id)}
                  className="stack small"
                  style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}
                >
                  <input type="hidden" name="taskId" value={t.id} />
                  <div>
                    <strong>{t.title}</strong>{' '}
                    <span className={`badge ${due.overdue ? 'bad' : ''}`}>{due.text}</span>
                    <div className="muted">
                      {TASK_TYPES[t.type]?.label ?? t.type} · {t.role}
                    </div>
                  </div>
                  <div className="row">
                    <input
                      name="effortMinutes"
                      inputMode="numeric"
                      placeholder="Minutes spent"
                      required
                      style={{ width: 130 }}
                    />
                    <input
                      name="outcome"
                      placeholder="Outcome"
                      style={{ flex: 1, minWidth: 120 }}
                    />
                    <button type="submit" className="secondary">
                      Done
                    </button>
                  </div>
                </form>
              );
            })}
          </section>

          {/* Facts */}
          <section className="card stack">
            <h2>Checklist</h2>
            <p className="muted small">
              Until the quote, payment and survey modules exist, record these by hand with evidence.
            </p>
            {(Object.keys(FACTS) as Fact[]).map((f) => {
              const value = snapshot.facts[f];
              const mine = canAttest(user.role, f);
              return (
                <details key={f}>
                  <summary className="small">
                    <span className={`badge ${value ? 'ok' : ''}`}>{value ? '✓' : '—'}</span>{' '}
                    {FACTS[f].label}
                  </summary>
                  {mine ? (
                    <form
                      action={attestFact.bind(null, p.id)}
                      className="row small"
                      style={{ marginTop: 6 }}
                    >
                      <input type="hidden" name="fact" value={f} />
                      <input type="hidden" name="value" value={value ? 'false' : 'true'} />
                      <input
                        name="note"
                        placeholder="Evidence / note (required)"
                        required
                        style={{ flex: 1 }}
                      />
                      <button type="submit" className="secondary">
                        {value ? 'Revoke' : 'Record'}
                      </button>
                    </form>
                  ) : (
                    <p className="muted small">
                      Recorded by: {FACTS[f].attestableBy.join(', ') || 'system only'}
                    </p>
                  )}
                </details>
              );
            })}
          </section>

          {/* Workstreams */}
          <section className="card stack">
            <h2>Workstreams</h2>
            {WORKSTREAM_NAMES.map((w) => {
              const current = snapshot.workstreams[w];
              const next = workstreamNext(w, current as never) as readonly string[];
              return (
                <form
                  key={w}
                  action={moveWorkstream.bind(null, p.id)}
                  className="stack small"
                  style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}
                >
                  <input type="hidden" name="workstream" value={w} />
                  <div>
                    <strong>{w}</strong>: {humanize(current)}
                  </div>
                  {canMoveWs && next.length > 0 && w !== 'bill' && (
                    <div className="row">
                      <select name="to" style={{ width: 'auto', flex: 1 }}>
                        {next.map((s) => (
                          <option key={s} value={s}>
                            {humanize(s)}
                          </option>
                        ))}
                      </select>
                      <input name="reason" placeholder="Note / reference" style={{ flex: 1 }} />
                      <button type="submit" className="secondary">
                        Update
                      </button>
                    </div>
                  )}
                </form>
              );
            })}
          </section>

          <section className="card small">
            <h2>Consents</h2>
            <ul>
              {d.consents.map((cn) => (
                <li key={cn.id}>
                  {cn.purpose} · {cn.textVersion} · {formatDateTime(cn.grantedAt)}
                  {cn.withdrawnAt && <span className="badge bad"> withdrawn</span>}
                </li>
              ))}
            </ul>
            <Link href="/ops">← All projects</Link>
          </section>
        </div>
      </div>
    </div>
  );
}
