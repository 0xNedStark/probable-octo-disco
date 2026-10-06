import type { LoanRow, QuoteRow } from '@solar/db';
import { formatDateTime, formatRupees, humanize } from '@/lib/format';
import { pickFinancePath, changeLoan } from './actions';

export function FinancePanel({
  projectId,
  financeState,
  loans,
  acceptedQuote,
  canManage,
}: {
  projectId: string;
  financeState: string;
  loans: LoanRow[];
  acceptedQuote: QuoteRow | null;
  canManage: boolean;
}) {
  const open = loans.find((l) => ['DOCS_PENDING', 'SUBMITTED', 'SANCTIONED'].includes(l.status));
  const loanOptions = acceptedQuote?.output.finance.filter((f) => f.loanPaise > 0) ?? [];
  return (
    <section className="card stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Finance</h2>
        <span className="badge">{humanize(financeState)}</span>
      </div>
      {canManage && !open && acceptedQuote && (
        <form action={pickFinancePath.bind(null, projectId)} className="row small">
          <select
            name="path"
            defaultValue={loanOptions[0]?.id ?? 'cash'}
            style={{ width: 'auto', flex: 1 }}
          >
            <option value="cash">Cash — pays in full</option>
            {loanOptions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label} — loan {formatRupees(f.loanPaise)}
              </option>
            ))}
          </select>
          <button type="submit" className="secondary">
            Set finance path
          </button>
        </form>
      )}
      {!acceptedQuote && (
        <p className="muted small">Choose cash or loan once the customer accepts a quote.</p>
      )}
      {loans.map((l) => (
        <div
          key={l.id}
          className="stack small"
          style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}
        >
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>
              {l.lender} · {formatRupees(l.requestedPaise)} requested
              {l.sanctionedPaise != null && ` · ${formatRupees(l.sanctionedPaise)} sanctioned`}
            </strong>
            <span className="badge">{humanize(l.status)}</span>
          </div>
          <div className="muted">
            {l.externalRef ? `Ref ${l.externalRef} · ` : ''}updated {formatDateTime(l.updatedAt)}
            {l.note ? ` · ${l.note}` : ''}
          </div>
          {Object.keys(l.checklist).length > 0 && (
            <ul className="req">
              {Object.entries(l.checklist).map(([item, ready]) => (
                <li key={item} className={ready ? 'met' : ''}>
                  {canManage && l.status === 'DOCS_PENDING' ? (
                    <form
                      action={changeLoan.bind(null, projectId, l.id)}
                      style={{ display: 'inline' }}
                    >
                      <input type="hidden" name="action" value="checklist" />
                      <input type="hidden" name="item" value={item} />
                      <input type="hidden" name="ready" value={ready ? 'false' : 'true'} />
                      {item}{' '}
                      <button
                        type="submit"
                        className="secondary"
                        style={{ padding: '0 6px', fontSize: '0.8rem' }}
                      >
                        {ready ? 'undo' : 'ready'}
                      </button>
                    </form>
                  ) : (
                    item
                  )}
                </li>
              ))}
            </ul>
          )}
          {canManage && l.status === 'DOCS_PENDING' && (
            <LoanAction
              projectId={projectId}
              loanId={l.id}
              action="submit"
              field="externalRef"
              placeholder="Bank / JanSamarth reference"
              label="Mark submitted"
            />
          )}
          {canManage && l.status === 'SUBMITTED' && (
            <>
              <LoanAction
                projectId={projectId}
                loanId={l.id}
                action="sanction"
                field="amountRupees"
                placeholder="Sanctioned ₹"
                label="Mark sanctioned"
              />
              <LoanAction
                projectId={projectId}
                loanId={l.id}
                action="reject"
                field="reason"
                placeholder="Bank’s reason"
                label="Mark rejected"
              />
            </>
          )}
          {canManage && l.status === 'SANCTIONED' && (
            <LoanAction
              projectId={projectId}
              loanId={l.id}
              action="disburse"
              field="amountRupees"
              placeholder="Disbursed ₹"
              label="Mark disbursed"
            />
          )}
          {canManage && (l.status === 'DOCS_PENDING' || l.status === 'SUBMITTED') && (
            <LoanAction
              projectId={projectId}
              loanId={l.id}
              action="withdraw"
              field="reason"
              placeholder="Why withdrawn"
              label="Withdraw"
            />
          )}
        </div>
      ))}
    </section>
  );
}

function LoanAction(props: {
  projectId: string;
  loanId: string;
  action: string;
  field: string;
  placeholder: string;
  label: string;
}) {
  return (
    <form action={changeLoan.bind(null, props.projectId, props.loanId)} className="row">
      <input type="hidden" name="action" value={props.action} />
      <input name={props.field} placeholder={props.placeholder} required style={{ flex: 1 }} />
      <button type="submit" className="secondary">
        {props.label}
      </button>
    </form>
  );
}
