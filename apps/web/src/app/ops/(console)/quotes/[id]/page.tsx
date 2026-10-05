import { getProjectDetail, getQuote, reproduceQuote, ServiceError } from '@solar/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ProposalView } from '@/app/proposal/proposal-view';
import { requireStaff } from '@/lib/auth';
import { getDb } from '@/lib/db';

export default async function QuotePreview({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;
  let quote;
  try {
    quote = await getQuote(getDb(), id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  const [d, repro] = await Promise.all([
    getProjectDetail(getDb(), quote.projectId),
    reproduceQuote(getDb(), id),
  ]);
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="row no-print small">
        <Link href={`/ops/projects/${quote.projectId}`}>← {d.project.code}</Link>
        <span className={`badge ${repro.matches ? 'ok' : 'bad'}`}>
          {repro.matches
            ? 'Reproduced exactly from stored inputs and config'
            : `Not reproducible: ${repro.reason}`}
        </span>
      </div>
      <ProposalView
        quote={quote}
        firstName={d.customer.name.split(/\s+/)[0] ?? d.customer.name}
        projectCode={d.project.code}
        staffPreview
      />
    </div>
  );
}
