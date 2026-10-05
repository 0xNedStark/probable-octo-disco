import type { LoadedConfig, QuoteRow } from '@solar/db';
import { sendBlockers } from '@solar/db';
import Link from 'next/link';
import { formatDateTime, formatRupees, humanize } from '@/lib/format';
import { createQuote, markQuoteAccepted, markQuoteSent } from './actions';

const STATUS_TONE: Record<string, string> = { ACCEPTED: 'ok', SENT: 'warn', SUPERSEDED: '' };

export function QuotePanel({
  projectId,
  quotes,
  config,
  canQuote,
  hasConfirmedReading,
}: {
  projectId: string;
  quotes: QuoteRow[];
  config: LoadedConfig;
  canQuote: boolean;
  hasConfirmedReading: boolean;
}) {
  const categories = Object.entries(config.bundle.tariff.categories);
  return (
    <section className="card stack">
      <h2>Quotes</h2>
      {config.bundle.pricebook.placeholder && (
        <p className="alert error small">
          Price book {config.labels.pricebook} is a placeholder. Quotes can be previewed but not
          sent until real supplier prices are published in <Link href="/ops/config">Config</Link>.
        </p>
      )}
      {canQuote && (
        <details open={quotes.length === 0}>
          <summary>New quote</summary>
          {!hasConfirmedReading ? (
            <p className="muted small">Confirm the bill readings first.</p>
          ) : (
            <form
              action={createQuote.bind(null, projectId)}
              className="stack small"
              style={{ marginTop: 8 }}
            >
              <div className="field-row">
                <div>
                  <label htmlFor="grade">Type</label>
                  <select id="grade" name="grade" defaultValue="INDICATIVE">
                    <option value="INDICATIVE">Indicative (from bill)</option>
                    <option value="FINAL">Final (after survey)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="tariffCategoryQ">Tariff category</label>
                  <select
                    id="tariffCategoryQ"
                    name="tariffCategory"
                    defaultValue={config.bundle.tariff.defaultCategory}
                  >
                    {categories.map(([k, v]) => (
                      <option key={k} value={k}>
                        {k} — {v.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field-row">
                <div>
                  <label htmlFor="roofAreaM2">Usable roof area, m² (optional)</label>
                  <input id="roofAreaM2" name="roofAreaM2" inputMode="decimal" />
                </div>
                <div>
                  <label htmlFor="targetOffsetPct">
                    Cover % of consumption (default{' '}
                    {Math.round(config.bundle.site.targetOffset * 100)})
                  </label>
                  <input id="targetOffsetPct" name="targetOffsetPct" inputMode="numeric" />
                </div>
              </div>
              <div>
                <label htmlFor="packageId">
                  System override (optional; engineers on final quotes)
                </label>
                <select id="packageId" name="packageId" defaultValue="">
                  <option value="">Recommend automatically</option>
                  {config.bundle.pricebook.packages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.kw} kW — {p.module.count} × {p.module.wp} Wp
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit">Calculate quote</button>
            </form>
          )}
        </details>
      )}
      {quotes.map((q) => {
        const o = q.output;
        const blockers = sendBlockers(q);
        return (
          <div
            key={q.id}
            className="stack small"
            style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}
          >
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>
                v{q.version} · {humanize(q.grade)} · {o.system.kw} kW
              </strong>
              <span className={`badge ${STATUS_TONE[q.status] ?? ''}`}>{humanize(q.status)}</span>
            </div>
            <div>
              {formatRupees(o.price.totalPaise)} incl. GST · subsidy{' '}
              {formatRupees(o.subsidy.totalPaise)} (to customer) · year-1 savings{' '}
              {formatRupees(o.savings.year1SavingsPaise)} · payback {o.savings.paybackYears ?? '—'}{' '}
              yrs
            </div>
            <div className="muted">
              {o.sizing.annualConsumptionKwh} kWh/yr ({o.sizing.monthsOfData} months of data) →
              target {o.sizing.targetKw} kW · {formatDateTime(q.createdAt)} · valid until{' '}
              {q.validUntil}
            </div>
            {o.flags.length > 0 && (
              <div className="row">
                {o.flags.map((f) => (
                  <span
                    key={f}
                    className={`badge ${f.startsWith('placeholder') || f === 'sanctioned_load_exceeded' ? 'warn' : ''}`}
                  >
                    {humanize(f)}
                  </span>
                ))}
              </div>
            )}
            <div className="row">
              <Link href={`/ops/quotes/${q.id}`}>Preview proposal</Link>
              {canQuote && q.status === 'DRAFT' && (
                <form action={markQuoteSent.bind(null, projectId, q.id)}>
                  <button type="submit" disabled={blockers.length > 0} title={blockers.join(' ')}>
                    Send to customer
                  </button>
                </form>
              )}
              {canQuote && q.status === 'SENT' && (
                <form action={markQuoteAccepted.bind(null, projectId, q.id)} className="row">
                  <input
                    name="note"
                    placeholder="How did the customer confirm?"
                    required
                    style={{ width: 220 }}
                  />
                  <button type="submit" className="secondary">
                    Record acceptance
                  </button>
                </form>
              )}
            </div>
            {q.status === 'DRAFT' && blockers.length > 0 && (
              <div className="muted">Can’t send: {blockers.join(' ')}</div>
            )}
          </div>
        );
      })}
    </section>
  );
}
