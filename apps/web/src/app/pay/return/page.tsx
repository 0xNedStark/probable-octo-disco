import { getPayment, statusUrl } from '@solar/db';
import type { Metadata } from 'next';
import { getDb } from '@/lib/db';
import { formatRupees } from '@/lib/format';
import { publicBaseUrl } from '@/lib/payments';

export const metadata: Metadata = { title: 'Payment', robots: { index: false } };

/** Where the gateway sends the customer back. The webhook, not this page, records the payment. */
export default async function PayReturn({
  searchParams,
}: {
  searchParams: Promise<{ payment?: string }>;
}) {
  const { payment: id } = await searchParams;
  const payment = id && /^pay_[0-9A-Z]{26}$/.test(id) ? await getPayment(getDb(), id) : null;
  const secret = process.env.STATUS_LINK_SECRET;
  return (
    <main className="container narrow">
      <div className="card stack">
        {payment?.status === 'PAID' ? (
          <>
            <h1>Payment received — thank you!</h1>
            <p>
              We have received {formatRupees(payment.amountPaise)}. Our team will call you to
              schedule your free site survey.
            </p>
            {secret && (
              <a href={statusUrl(payment.projectId, publicBaseUrl(), secret)}>Track your project</a>
            )}
          </>
        ) : (
          <>
            <h1>We’re confirming your payment</h1>
            <p className="muted">
              This can take a minute. Refresh this page, or wait for our WhatsApp confirmation.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
