import { getProjectDetail, listPayments, verifyStatusToken } from '@solar/db';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  CUSTOMER_STEPS,
  FINANCE_COPY,
  isMainStage,
  REGULATORY_COPY,
  SIDE_STAGE_COPY,
  stageIndex,
} from '@solar/domain';
import { getDb } from '@/lib/db';
import { formatDateTime, formatRupees } from '@/lib/format';

export const metadata: Metadata = {
  title: 'Your solar project',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/** Customer status timeline. Shows only customer-safe fields — no notes, staff names or internal ids. */
export default async function StatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const projectId = verifyStatusToken(token, process.env.STATUS_LINK_SECRET ?? '');
  if (!projectId) notFound();
  const [d, payments] = await Promise.all([
    getProjectDetail(getDb(), projectId),
    listPayments(getDb(), projectId),
  ]);
  const p = d.project;
  const current = isMainStage(p.stage) ? p.stage : p.heldFromStage;
  const currentIdx = current ? stageIndex(current) : -1;
  const step = CUSTOMER_STEPS.find((s) => s.stage === current);
  const paid = payments.filter((x) => x.status === 'PAID');
  const finance = FINANCE_COPY[p.financeState];
  const regulatory = REGULATORY_COPY[p.regulatoryState];
  const firstName = d.customer.name.split(/\s+/)[0];

  return (
    <main className="container narrow">
      <div className="stack">
        <p className="muted small">{p.code}</p>
        <h1>Namaste {firstName}, here’s where your solar project stands</h1>
        <div className="card stack">
          <h2>{SIDE_STAGE_COPY[p.stage] ? SIDE_STAGE_COPY[p.stage] : step?.title}</h2>
          {!SIDE_STAGE_COPY[p.stage] && step && <p>{step.next}</p>}
          {finance && <p className="small">💳 {finance}</p>}
          {regulatory && <p className="small">⚡ {regulatory}</p>}
        </div>
        <ol className="card timeline">
          {CUSTOMER_STEPS.map((s, i) => (
            <li key={s.stage} className={i <= currentIdx ? '' : 'muted'}>
              {i < currentIdx ? '✓' : i === currentIdx ? '●' : '○'} {s.title}
            </li>
          ))}
        </ol>
        {paid.length > 0 && (
          <div className="card small">
            <h2>Payments received</h2>
            <ul>
              {paid.map((x) => (
                <li key={x.id}>
                  {formatRupees(x.amountPaise, { whole: true })} · {formatDateTime(x.paidAt)}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="muted small">Questions? Reply to us on WhatsApp — we’re happy to help.</p>
      </div>
    </main>
  );
}
