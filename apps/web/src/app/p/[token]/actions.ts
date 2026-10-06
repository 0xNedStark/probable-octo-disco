'use server';

import {
  acceptWithOtp,
  requestAcceptanceOtp,
  requestBookingPayment,
  ServiceError,
} from '@solar/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
import { getPaymentProvider, publicBaseUrl } from '@/lib/payments';
import { allowRequest } from '@/lib/rate-limit';

export interface AcceptState {
  step: 'agree' | 'code';
  maskedPhone?: string;
  error?: string;
}

async function clientIp(): Promise<string> {
  return (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export async function sendCode(
  token: string,
  _prev: AcceptState,
  form: FormData,
): Promise<AcceptState> {
  if (form.get('agree') !== 'on')
    return { step: 'agree', error: 'Please tick the box to agree to the terms.' };
  if (!allowRequest(`otp:${await clientIp()}`, 10, 60 * 60 * 1000)) {
    return { step: 'agree', error: 'Too many requests. Please try again later.' };
  }
  try {
    const { maskedPhone } = await requestAcceptanceOtp(getDb(), token);
    return { step: 'code', maskedPhone };
  } catch (e) {
    if (e instanceof ServiceError) return { step: 'agree', error: e.message };
    throw e;
  }
}

export async function confirmCode(
  token: string,
  prev: AcceptState,
  form: FormData,
): Promise<AcceptState> {
  const h = await headers();
  let accepted;
  try {
    accepted = await acceptWithOtp(getDb(), token, String(form.get('code') ?? ''), {
      ip: await clientIp(),
      userAgent: h.get('user-agent') ?? undefined,
    });
  } catch (e) {
    if (e instanceof ServiceError) return { ...prev, step: 'code', error: e.message };
    throw e;
  }
  const provider = getPaymentProvider();
  if (accepted.grade === 'INDICATIVE' && provider) {
    let payUrl: string | null = null;
    try {
      const payment = await requestBookingPayment(
        getDb(),
        { type: 'system', id: 'customer-link' },
        accepted.projectId,
        provider,
        publicBaseUrl(),
      );
      payUrl = payment.payUrl;
    } catch (e) {
      // Acceptance is recorded; ops will follow up with a payment link.
      console.error('[payments] could not create booking link', e);
    }
    if (payUrl) redirect(payUrl);
  }
  redirect(`/p/${token}?accepted=1`);
}
