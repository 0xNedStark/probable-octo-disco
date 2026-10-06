import { getPayment } from '@solar/db';
import { DevPaymentProvider } from '@solar/integrations';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { formatRupees } from '@/lib/format';
import { getPaymentProvider } from '@/lib/payments';
import { simulateDevPayment } from './actions';

/** Simulated gateway checkout, only when PAYMENTS_PROVIDER=dev. */
export default async function DevPay({ params }: { params: Promise<{ paymentId: string }> }) {
  if (!(getPaymentProvider() instanceof DevPaymentProvider)) notFound();
  const { paymentId } = await params;
  const payment = await getPayment(getDb(), paymentId);
  if (!payment) notFound();
  return (
    <main className="container narrow">
      <div className="card stack">
        <p className="badge warn">Test payment gateway — no real money moves</p>
        <h1>Pay {formatRupees(payment.amountPaise)}</h1>
        <p className="muted">Booking token · status {payment.status.toLowerCase()}</p>
        {payment.status === 'CREATED' && (
          <form action={simulateDevPayment.bind(null, payment.id)}>
            <button type="submit">Pay {formatRupees(payment.amountPaise)} (simulated UPI)</button>
          </form>
        )}
      </div>
    </main>
  );
}
