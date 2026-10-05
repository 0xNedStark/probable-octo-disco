import type { ProjectDetail } from '@solar/db';
import { formatDateTime, formatRupees, humanize } from '@/lib/format';
import { askForNewBill, saveReadings, uploadBill } from './actions';

type Reading = ProjectDetail['readings'][number];

const FIELD_LABELS: Record<string, string> = {
  consumerNumber: 'account number',
  discom: 'DISCOM',
  tariffCategory: 'tariff',
  sanctionedLoadKw: 'sanctioned load',
  periodStart: 'period start',
  periodEnd: 'period end',
  unitsKwh: 'units',
  amountRupees: 'amount',
};

function ConfidenceList({ r, threshold }: { r: Reading; threshold: number }) {
  if (!r.confidence) return null;
  const low = Object.entries(r.confidence).filter(([, c]) => c < threshold);
  if (!low.length) return <span className="badge ok">all fields high confidence</span>;
  return (
    <span className="badge warn">
      check: {low.map(([f, c]) => `${FIELD_LABELS[f] ?? f} (${Math.round(c * 100)}%)`).join(', ')}
    </span>
  );
}

export function BillSection({
  d,
  canBill,
  threshold,
}: {
  d: ProjectDetail;
  canBill: boolean;
  threshold: number;
}) {
  const { project: p, customer: c } = d;
  const latestBill = d.bills[0];
  const confirmed = d.readings.find((r) => r.status === 'confirmed');
  const proposal = d.readings.find((r) => r.status === 'proposed');
  const needsReadings = ['RECEIVED', 'EXTRACTED', 'NEEDS_MANUAL'].includes(p.billState);
  // Pre-fill from the AI proposal when there is one; a person still confirms every value.
  const v = proposal;

  return (
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
              {Math.round(b.sizeBytes / 1024)} KB · {b.source} · {formatDateTime(b.uploadedAt)}
            </span>
          </li>
        ))}
      </ul>
      {confirmed && (
        <div className="small">
          <strong>Confirmed readings</strong> ({confirmed.source},{' '}
          {formatDateTime(confirmed.confirmedAt ?? confirmed.createdAt)}): {confirmed.unitsKwh} kWh,{' '}
          {formatRupees(confirmed.amountPaise)} for {confirmed.periodStart} → {confirmed.periodEnd};{' '}
          {confirmed.tariffCategory}; sanctioned load {confirmed.sanctionedLoadW / 1000} kW; A/c{' '}
          {confirmed.consumerNumber}
          {confirmed.monthlyHistory.length > 0 && (
            <>
              {' '}
              · history: {confirmed.monthlyHistory.map((m) => `${m.month} ${m.units}`).join(', ')}
            </>
          )}
        </div>
      )}
      {canBill && latestBill && needsReadings && (
        <details open>
          <summary>
            {proposal
              ? 'Review the automatic reading against the bill'
              : 'Enter readings from the bill'}
          </summary>
          {proposal && (
            <p className="small" style={{ marginTop: 8 }}>
              Read automatically — compare every value with the bill before confirming.{' '}
              <ConfidenceList r={proposal} threshold={threshold} />
            </p>
          )}
          <form action={saveReadings.bind(null, p.id)} className="stack" style={{ marginTop: 8 }}>
            <input type="hidden" name="billId" value={proposal?.billId ?? latestBill.id} />
            {proposal && <input type="hidden" name="proposedReadingId" value={proposal.id} />}
            <div className="field-row">
              <div>
                <label htmlFor="consumerNumber">Account / consumer number</label>
                <input
                  id="consumerNumber"
                  name="consumerNumber"
                  required
                  defaultValue={v?.consumerNumber ?? c.consumerNumber ?? ''}
                />
              </div>
              <div>
                <label htmlFor="discom">DISCOM</label>
                <input
                  id="discom"
                  name="discom"
                  required
                  defaultValue={v?.discom ?? c.discom ?? 'DVVNL'}
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
                  defaultValue={v?.tariffCategory}
                />
              </div>
              <div>
                <label htmlFor="sanctionedLoadKw">Sanctioned load (kW)</label>
                <input
                  id="sanctionedLoadKw"
                  name="sanctionedLoadKw"
                  required
                  inputMode="decimal"
                  defaultValue={v ? v.sanctionedLoadW / 1000 : undefined}
                />
              </div>
            </div>
            <div className="field-row">
              <div>
                <label htmlFor="periodStart">Period start</label>
                <input
                  id="periodStart"
                  name="periodStart"
                  type="date"
                  required
                  defaultValue={v?.periodStart}
                />
              </div>
              <div>
                <label htmlFor="periodEnd">Period end</label>
                <input
                  id="periodEnd"
                  name="periodEnd"
                  type="date"
                  required
                  defaultValue={v?.periodEnd}
                />
              </div>
            </div>
            <div className="field-row">
              <div>
                <label htmlFor="unitsKwh">Units (kWh)</label>
                <input
                  id="unitsKwh"
                  name="unitsKwh"
                  required
                  inputMode="numeric"
                  defaultValue={v?.unitsKwh}
                />
              </div>
              <div>
                <label htmlFor="amountRupees">Bill amount (₹)</label>
                <input
                  id="amountRupees"
                  name="amountRupees"
                  required
                  inputMode="decimal"
                  defaultValue={v ? v.amountPaise / 100 : undefined}
                />
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
                defaultValue={v?.monthlyHistory.map((m) => `${m.month}: ${m.units}`).join('\n')}
              />
            </div>
            <button type="submit">
              {proposal ? 'Confirm readings' : 'Save readings and confirm bill'}
            </button>
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
  );
}
