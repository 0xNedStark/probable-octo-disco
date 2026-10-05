import { getQuoteByToken } from '@solar/db';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProposalView } from '@/app/proposal/proposal-view';
import { getDb } from '@/lib/db';

export const metadata: Metadata = {
  title: 'Your rooftop solar proposal',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function CustomerProposal({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await getQuoteByToken(getDb(), token);
  if (!found) notFound();
  return (
    <main className="container narrow" style={{ maxWidth: 760 }}>
      <ProposalView
        quote={found.quote}
        firstName={found.firstName}
        projectCode={found.projectCode}
      />
    </main>
  );
}
