'use server';

import { getPayment, processPaymentEvent } from '@solar/db';
import { DevPaymentProvider } from '@solar/integrations';
import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
import { getPaymentProvider } from '@/lib/payments';

/** Produces the same signed webhook a gateway would and runs it through the real handler. */
export async function simulateDevPayment(paymentId: string) {
  const provider = getPaymentProvider();
  if (!(provider instanceof DevPaymentProvider)) throw new Error('dev payments disabled');
  const payment = await getPayment(getDb(), paymentId);
  if (!payment) throw new Error('payment not found');
  const { body, headers } = provider.simulatePaid(paymentId, payment.amountPaise);
  const event = provider.parseWebhook(body, headers);
  if (!event) throw new Error('signature check failed');
  await processPaymentEvent(getDb(), provider.name, event, JSON.parse(body));
  redirect(`/pay/return?payment=${paymentId}`);
}
