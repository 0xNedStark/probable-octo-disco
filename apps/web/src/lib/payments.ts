import 'server-only';
import { paymentProviderFromEnv, type PaymentProvider } from '@solar/integrations';

let provider: PaymentProvider | null | undefined;

/** Null when PAYMENTS_PROVIDER is not configured (payments are then recorded manually). */
export function getPaymentProvider(): PaymentProvider | null {
  if (provider === undefined) provider = paymentProviderFromEnv();
  return provider;
}

export function publicBaseUrl(): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) throw new Error('PUBLIC_BASE_URL is not set');
  return base;
}
