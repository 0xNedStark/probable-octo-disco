import type { PaymentRow } from '@solar/db';
import { formatDateTime, formatRupees, humanize } from '@/lib/format';
import { addManualPayment, addRefund, requestBooking } from './actions';

const TONE: Record<string, string> = {
  PAID: 'ok',
  CREATED: 'warn',
  REFUNDED: '',
  FAILED: 'bad',
  EXPIRED: '',
  CANCELLED: '',
};

export function PaymentsPanel({
  projectId,
  payments,
  balancePaise,
  canManage,
  canRequest,
  gatewayConfigured,
}: {
  projectId: string;
  payments: PaymentRow[];
  balancePaise: number;
  canManage: boolean;
  canRequest: boolean;
  gatewayConfigured: boolean;
}) {
  return (
    <section className="card stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Payments</h2>
        <span className="small">
          Held for customer: <strong>{formatRupees(balancePaise)}</strong>
        </span>
      </div>
      {payments.length === 0 && <p className="muted small">No payments yet.</p>}
      {payments.map((p) => (
        <div
          key={p.id}
          className="small stack"
          style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}
        >
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              {humanize(p.purpose)} · {formatRupees(p.amountPaise)} · {p.provider}
              {p.reference ? ` · ${p.reference}` : ''}
            </span>
            <span className={`badge ${TONE[p.status] ?? ''}`}>{humanize(p.status)}</span>
          </div>
          <div className="muted">
            requested {formatDateTime(p.createdAt)}
            {p.paidAt && ` · paid ${formatDateTime(p.paidAt)}`}
            {p.status === 'CREATED' && p.payUrl && (
              <>
                {' '}
                · <a href={p.payUrl}>payment link</a>
              </>
            )}
          </div>
          {canManage && p.status === 'PAID' && (
            <details>
              <summary>Record refund</summary>
              <form
                action={addRefund.bind(null, projectId, p.id)}
                className="row"
                style={{ marginTop: 6 }}
              >
                <input
                  name="amountRupees"
                  inputMode="decimal"
                  placeholder="Amount ₹"
                  required
                  style={{ width: 110 }}
                />
                <input
                  name="reference"
                  placeholder="Refund reference"
                  required
                  style={{ width: 150 }}
                />
                <input
                  name="reason"
                  placeholder="Reason (per refund policy)"
                  required
                  style={{ flex: 1 }}
                />
                <button type="submit" className="secondary">
                  Record
                </button>
              </form>
            </details>
          )}
        </div>
      ))}
      {canRequest && gatewayConfigured && (
        <form action={requestBooking.bind(null, projectId)}>
          <button type="submit" className="secondary">
            Send booking payment link
          </button>
        </form>
      )}
      {canManage && (
        <details>
          <summary className="small">Record a UPI / bank transfer</summary>
          <form
            action={addManualPayment.bind(null, projectId)}
            className="stack small"
            style={{ marginTop: 6 }}
          >
            <div className="row">
              <select name="purpose" defaultValue="booking_advance" style={{ width: 'auto' }}>
                <option value="booking_advance">Booking advance</option>
                <option value="milestone">Milestone</option>
                <option value="other">Other</option>
              </select>
              <input
                name="amountRupees"
                inputMode="decimal"
                placeholder="Amount ₹"
                required
                style={{ width: 120 }}
              />
              <input name="reference" placeholder="UTR / reference" required style={{ flex: 1 }} />
              <button type="submit">Record payment</button>
            </div>
          </form>
        </details>
      )}
    </section>
  );
}
