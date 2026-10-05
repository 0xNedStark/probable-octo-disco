import { getProjectDetail, ServiceError } from '@solar/db';
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
import {
  askForNewBill,
  attestFact,
  finishTask,
  moveStage,
  moveWorkstream,
  saveReadings,
  uploadBill,
} from './actions';

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

  let d;
  try {
    d = await getProjectDetail(getDb(), id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  const { project: p, customer: c, snapshot } = d;
  const latestBill = d.bills[0];
  const latestReading = d.readings[0];
  const canMove = can(user.role, 'project.transition');
  const canMoveWs = can(user.role, 'workstream.transition');
  const canBill = can(user.role, 'bill.enter_readings');
  const needsReadings = ['RECEIVED', 'EXTRACTED', 'NEEDS_MANUAL'].includes(p.billState);
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

          {/* Bill */}
          <section className="card stack">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2>Electricity bill</h2>
              <span className="badge">{humanize(p.billState)}</span>
            </div>
            {d.bills.length === 0 && <p className="muted">No bill yet.</p>}
            <ul className="small">
              {d.bills.map((b) => (
                <li key={b.id}>
                  <a href={`/ops/files/bills/${b.id}`} target="_blank" rel="noreferrer">
                    {b.originalFilename}
                  </a>{' '}
                  <span className="muted">
                    {Math.round(b.sizeBytes / 1024)} KB · {b.source} ·{' '}
                    {formatDateTime(b.uploadedAt)}
                  </span>
                </li>
              ))}
            </ul>
            {latestReading && (
              <div className="small">
                <strong>Latest readings</strong> ({latestReading.source},{' '}
                {formatDateTime(latestReading.createdAt)}): {latestReading.unitsKwh} kWh,{' '}
                {formatRupees(latestReading.amountPaise)} for {latestReading.periodStart} →{' '}
                {latestReading.periodEnd}; {latestReading.tariffCategory}; sanctioned load{' '}
                {latestReading.sanctionedLoadW / 1000} kW; A/c {latestReading.consumerNumber}
                {latestReading.monthlyHistory.length > 0 && (
                  <>
                    {' '}
                    · history:{' '}
                    {latestReading.monthlyHistory.map((m) => `${m.month} ${m.units}`).join(', ')}
                  </>
                )}
              </div>
            )}
            {canBill && latestBill && needsReadings && (
              <details open>
                <summary>Enter readings from the bill</summary>
                <form
                  action={saveReadings.bind(null, p.id)}
                  className="stack"
                  style={{ marginTop: 8 }}
                >
                  <input type="hidden" name="billId" value={latestBill.id} />
                  <div className="field-row">
                    <div>
                      <label htmlFor="consumerNumber">Account / consumer number</label>
                      <input
                        id="consumerNumber"
                        name="consumerNumber"
                        required
                        defaultValue={c.consumerNumber ?? ''}
                      />
                    </div>
                    <div>
                      <label htmlFor="discom">DISCOM</label>
                      <input
                        id="discom"
                        name="discom"
                        required
                        defaultValue={c.discom ?? 'DVVNL'}
                      />
                    </div>
                  </div>
                  <div className="field-row">
                    <div>
                      <label htmlFor="tariffCategory">Tariff category</label>
                      <input
                        id="tariffCategory"
                        name="tariffCategory"
                        required
                        placeholder="e.g. LMV-1"
                      />
                    </div>
                    <div>
                      <label htmlFor="sanctionedLoadKw">Sanctioned load (kW)</label>
                      <input
                        id="sanctionedLoadKw"
                        name="sanctionedLoadKw"
                        required
                        inputMode="decimal"
                      />
                    </div>
                  </div>
                  <div className="field-row">
                    <div>
                      <label htmlFor="periodStart">Period start</label>
                      <input id="periodStart" name="periodStart" type="date" required />
                    </div>
                    <div>
                      <label htmlFor="periodEnd">Period end</label>
                      <input id="periodEnd" name="periodEnd" type="date" required />
                    </div>
                  </div>
                  <div className="field-row">
                    <div>
                      <label htmlFor="unitsKwh">Units (kWh)</label>
                      <input id="unitsKwh" name="unitsKwh" required inputMode="numeric" />
                    </div>
                    <div>
                      <label htmlFor="amountRupees">Bill amount (₹)</label>
                      <input id="amountRupees" name="amountRupees" required inputMode="decimal" />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="monthlyHistory">
                      Monthly history from the bill, one per line (optional)
                    </label>
                    <textarea
                      id="monthlyHistory"
                      name="monthlyHistory"
                      rows={3}
                      placeholder={'2026-07: 450\n2026-06: 510'}
                    />
                  </div>
                  <button type="submit">Save readings and confirm bill</button>
                </form>
              </details>
            )}
            {canBill && latestBill && needsReadings && (
              <form action={askForNewBill.bind(null, p.id)} className="row">
                <input
                  name="reason"
                  placeholder="What's wrong with the bill?"
                  required
                  style={{ flex: 1 }}
                />
                <button type="submit" className="secondary">
                  Ask for clearer bill
                </button>
              </form>
            )}
            {canBill && (
              <form action={uploadBill.bind(null, p.id)} className="row">
                <input
                  type="file"
                  name="bill"
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  style={{ flex: 1 }}
                />
                <button type="submit" className="secondary">
                  Upload bill for customer
                </button>
              </form>
            )}
          </section>

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
