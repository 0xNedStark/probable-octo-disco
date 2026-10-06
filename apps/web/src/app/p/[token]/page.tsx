import { activeConfig, getQuoteByToken } from '@solar/db';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProposalView } from '@/app/proposal/proposal-view';
import { getDb } from '@/lib/db';
import { formatRupees } from '@/lib/format';
import { AcceptPanel } from './accept-panel';

export const metadata: Metadata = {
  title: 'Your rooftop solar proposal',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function CustomerProposal({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ accepted?: string }>;
}) {
  const { token } = await params;
  const { accepted } = await searchParams;
  const found = await getQuoteByToken(getDb(), token);
  if (!found) notFound();
  const q = found.quote;
  const today = new Date().toISOString().slice(0, 10);
  const commercial = (await activeConfig(getDb())).bundle.commercial;

  let slot = null;
  if (q.status === 'ACCEPTED' || accepted) {
    slot = (
      <p className="alert ok">
        You accepted this proposal. Thank you — our team will be in touch shortly.
      </p>
    );
  } else if (q.status === 'SENT' && q.validUntil >= today) {
    slot = (
      <AcceptPanel
        token={token}
        bookingToken={
          q.grade === 'INDICATIVE'
            ? formatRupees(commercial.bookingTokenPaise, { whole: true })
            : '—'
        }
        policy={commercial.refundPolicySummary}
        policyVersion={commercial.refundPolicyVersion}
      />
    );
  }
  return (
    <main className="container narrow" style={{ maxWidth: 760 }}>
      <ProposalView
        quote={q}
        firstName={found.firstName}
        projectCode={found.projectCode}
        acceptSlot={slot}
      />
    </main>
  );
}
