import type { QuoteRow } from '@solar/db';
import { formatRupees as formatExact } from '@/lib/format';

/** Customers see whole rupees; exact paise stay in the stored quote. */
const formatRupees = (paise: number | null | undefined) => formatExact(paise, { whole: true });
import { PrintButton } from './print-button';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const FLAG_NOTES: Partial<Record<string, string>> = {
  extrapolated_consumption:
    'Your yearly usage is estimated from the months shown on your bill. More months of bills make this more accurate.',
  sanctioned_load_exceeded:
    'The recommended system is larger than your sanctioned load, so DVVNL may require a load increase. We handle that application.',
  roof_limited: 'System size is limited by the roof area available.',
  consumption_below_smallest_package:
    'Your usage is low; this is the smallest standard system we install.',
};

/**
 * Customer-facing proposal. Every number comes from the stored quote output —
 * nothing here is computed or invented at render time.
 */
export function ProposalView({
  quote,
  firstName,
  projectCode,
  staffPreview = false,
}: {
  quote: QuoteRow;
  firstName: string;
  projectCode: string;
  staffPreview?: boolean;
}) {
  const o = quote.output;
  const avg = (a: number[]) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const before = avg(o.savings.monthlyBillBeforePaise);
  const after = avg(o.savings.monthlyBillAfterPaise);
  const loans = o.finance.filter((f) => f.id !== 'cash');
  const placeholderLoans = o.flags.includes('placeholder_lender_terms');
  const today = new Date().toISOString().slice(0, 10);

  return (
    <article className="stack proposal">
      {staffPreview && (
        <p className="alert error no-print">
          Staff preview of quote v{quote.version} ({quote.status.toLowerCase()}).
          {o.flags.includes('placeholder_prices') && ' Placeholder prices: not for customers.'}
        </p>
      )}
      {quote.status === 'SUPERSEDED' && !staffPreview && (
        <p className="alert error">
          This proposal has been replaced by a newer one. Please use the latest link we sent you.
        </p>
      )}
      {quote.validUntil < today && (
        <p className="alert error">This proposal expired on {quote.validUntil}.</p>
      )}

      <header className="stack">
        <p className="muted small">
          {projectCode} · Proposal v{quote.version} · valid until {quote.validUntil}
        </p>
        <h1>
          {firstName}, here is your {o.system.kw} kW rooftop solar proposal
        </h1>
        {quote.grade === 'INDICATIVE' && (
          <p className="muted">
            Based on your electricity bill. The final price is confirmed after a free site survey of
            your roof.
          </p>
        )}
      </header>

      <section className="grid grid-3">
        <div className="card">
          <div className="muted small">Average monthly bill today</div>
          <div className="stat">{formatRupees(before)}</div>
        </div>
        <div className="card">
          <div className="muted small">Estimated with solar</div>
          <div className="stat">{formatRupees(after)}</div>
          <div className="muted small">fixed charges and meter rent remain</div>
        </div>
        <div className="card">
          <div className="muted small">Estimated savings in year 1</div>
          <div className="stat">{formatRupees(o.savings.year1SavingsPaise)}</div>
          {o.savings.paybackYears != null && (
            <div className="muted small">pays back in about {o.savings.paybackYears} years</div>
          )}
        </div>
      </section>

      <section className="card stack">
        <h2>Your system</h2>
        <ul>
          <li>
            {o.system.moduleCount} × {o.system.moduleWp} Wp{' '}
            {o.system.dcr ? 'made-in-India (DCR) ' : ''}solar panels
          </li>
          <li>{o.system.inverterKw} kW on-grid inverter</li>
          <li>
            Expected generation in year 1: about {o.generation.year1Kwh.toLocaleString('en-IN')}{' '}
            units (kWh)
          </li>
          <li>DVVNL net metering: extra units you export are adjusted against units you use</li>
        </ul>
      </section>

      <section className="card stack">
        <h2>Price and subsidy</h2>
        <table>
          <tbody>
            <tr>
              <td>System price (including GST)</td>
              <td style={{ textAlign: 'right' }}>
                <strong>{formatRupees(o.price.totalPaise)}</strong>
              </td>
            </tr>
            {o.subsidy.schemes
              .filter((s) => s.amountPaise > 0)
              .map((s) => (
                <tr key={s.id}>
                  <td>{s.label}</td>
                  <td style={{ textAlign: 'right' }}>− {formatRupees(s.amountPaise)}</td>
                </tr>
              ))}
            <tr>
              <td>
                <strong>Your cost after subsidy</strong>
              </td>
              <td style={{ textAlign: 'right' }}>
                <strong>{formatRupees(o.netCostAfterSubsidyPaise)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
        {o.subsidy.totalPaise > 0 && o.subsidy.recipient === 'customer' && (
          <p className="small">
            <strong>How the subsidy works:</strong> you pay the full system price first. The
            government credits {formatRupees(o.subsidy.totalPaise)} directly to your bank account
            after DVVNL inspects and commissions the system — usually a few weeks later. We file and
            track the paperwork for you.
          </p>
        )}
      </section>

      <section className="card stack">
        <h2>Ways to pay</h2>
        <table>
          <thead>
            <tr>
              <th>Option</th>
              <th>You pay upfront</th>
              <th>Loan</th>
              <th>Monthly EMI</th>
            </tr>
          </thead>
          <tbody>
            {o.finance.map((f) => (
              <tr key={f.id}>
                <td>{f.label}</td>
                <td>{formatRupees(f.payNowPaise)}</td>
                <td>{f.loanPaise ? formatRupees(f.loanPaise) : '—'}</td>
                <td>
                  {f.emiPaise != null ? (
                    <>
                      {formatRupees(f.emiPaise)}
                      <div className="muted small">
                        {f.annualRatePct}% for {f.tenorMonths} months
                      </div>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loans.length > 0 && (
          <p className="muted small">
            Loan figures are illustrative and subject to the bank’s approval and current rates
            {placeholderLoans ? '; terms are still being confirmed with the bank' : ''}. You apply
            to the bank directly; we help with the paperwork. The bank, not us, is your lender.
          </p>
        )}
      </section>

      <section className="card stack">
        <h2>Savings over time</h2>
        <p>
          Over {o.savings.lifetimeYears} years: about{' '}
          <strong>{formatRupees(o.savings.lifetimeSavingsPaise)}</strong> in lower bills (at today’s
          tariff).
        </p>
        <table>
          <thead>
            <tr>
              <th>If sunshine is…</th>
              <th>Year-1 savings</th>
              <th>Payback</th>
            </tr>
          </thead>
          <tbody>
            {o.savings.scenarios.map((s) => (
              <tr key={s.yieldFactor}>
                <td>
                  {s.yieldFactor < 1
                    ? 'Below average'
                    : s.yieldFactor > 1
                      ? 'Above average'
                      : 'Average'}
                </td>
                <td>{formatRupees(s.year1SavingsPaise)}</td>
                <td>{s.paybackYears != null ? `${s.paybackYears} years` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <details className="small">
          <summary>Month by month (year 1)</summary>
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Bill today</th>
                <th>With solar</th>
              </tr>
            </thead>
            <tbody>
              {MONTHS.map((m, i) => (
                <tr key={m}>
                  <td>{m}</td>
                  <td>{formatRupees(o.savings.monthlyBillBeforePaise[i])}</td>
                  <td>{formatRupees(o.savings.monthlyBillAfterPaise[i])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        {o.flags.map(
          (f) =>
            FLAG_NOTES[f] && (
              <p key={f} className="muted small">
                {FLAG_NOTES[f]}
              </p>
            ),
        )}
      </section>

      <section className="card stack">
        <h2>Next step</h2>
        <p>
          Reply <strong>YES</strong> on WhatsApp or tell our team when you call, and we will
          schedule a free site survey.
        </p>
        <PrintButton />
      </section>

      <details className="card small">
        <summary>Price breakdown and assumptions</summary>
        <table>
          <tbody>
            {o.price.lines.map((l) => (
              <tr key={l.code}>
                <td>{l.label}</td>
                <td style={{ textAlign: 'right' }}>{formatRupees(l.amountPaise)}</td>
              </tr>
            ))}
            <tr>
              <td>GST</td>
              <td style={{ textAlign: 'right' }}>{formatRupees(o.price.gstPaise)}</td>
            </tr>
          </tbody>
        </table>
        <ul>
          {o.assumptions.map((a) => (
            <li key={a.key}>
              {a.label}: {a.value} <span className="muted">({a.source})</span>
            </li>
          ))}
        </ul>
        <p className="muted">
          Calculation {o.calcVersion} · config {quote.configHash.slice(0, 12)} · these are
          estimates, not guarantees; actual savings depend on weather, usage and tariff changes.
        </p>
      </details>
    </article>
  );
}
