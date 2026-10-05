'use server';

import { createLead, ServiceError } from '@solar/db';
import { newId } from '@solar/domain';
import { checkBillFile, sha256 } from '@solar/integrations';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { CONSENT_TEXT_VERSION } from '@/lib/consent';
import { getDb } from '@/lib/db';
import { allowRequest } from '@/lib/rate-limit';
import { getStorage } from '@/lib/storage';

export interface LeadFormState {
  error: string | null;
  values?: Record<string, string>;
}

const LeadSchema = z.object({
  name: z.string().trim().min(1, 'Please enter your name.').max(120),
  phone: z.string().trim().min(1, 'Please enter your mobile number.').max(20),
  city: z.string().trim().min(1, 'Please enter your city.').max(80),
  pincode: z
    .string()
    .trim()
    .regex(/^(\d{6})?$/, 'PIN code should be 6 digits.')
    .optional(),
  consumerNumber: z.string().trim().max(30).optional(),
  monthlyBill: z
    .string()
    .trim()
    .regex(/^(\d{1,7})?$/, 'Monthly bill should be a number of rupees.')
    .optional(),
  consentContact: z.literal('on', { error: 'Please agree to be contacted so we can help you.' }),
  consentWhatsapp: z.literal('on').optional(),
});

const TEXT_FIELDS = ['name', 'phone', 'city', 'pincode', 'consumerNumber', 'monthlyBill'] as const;

export async function submitLead(_prev: LeadFormState, form: FormData): Promise<LeadFormState> {
  const values = Object.fromEntries(TEXT_FIELDS.map((k) => [k, String(form.get(k) ?? '')]));
  const fail = (error: string): LeadFormState => ({ error, values });

  // Bots fill the hidden field; pretend success without storing anything.
  if (String(form.get('website') ?? '')) redirect('/thanks');

  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!allowRequest(`lead:${ip}`, 10, 60 * 60 * 1000)) {
    return fail('Too many requests. Please try again later or message us on WhatsApp.');
  }

  const parsed = LeadSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Please check the form.');
  const d = parsed.data;

  let bill;
  const file = form.get('bill');
  if (file instanceof File && file.size > 0) {
    const body = new Uint8Array(await file.arrayBuffer());
    const check = checkBillFile(body);
    if (!check.ok) return fail(check.error);
    const id = newId('bill');
    const now = new Date();
    const storageKey = `bills/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.${check.ext}`;
    await getStorage().put(storageKey, body, check.contentType);
    bill = {
      id,
      storageKey,
      originalFilename: file.name.slice(0, 200) || `bill.${check.ext}`,
      contentType: check.contentType,
      sizeBytes: body.byteLength,
      sha256: sha256(body),
    };
  }

  try {
    await createLead(getDb(), {
      name: d.name,
      phone: d.phone,
      city: d.city,
      pincode: d.pincode || undefined,
      consumerNumber: d.consumerNumber || undefined,
      statedMonthlyBillRupees: d.monthlyBill ? Number(d.monthlyBill) : undefined,
      source: 'web',
      referrer: h.get('referer') ?? undefined,
      consent: {
        contact: true,
        whatsapp: d.consentWhatsapp === 'on',
        textVersion: CONSENT_TEXT_VERSION,
        channel: 'web',
      },
      bill,
    });
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'INVALID') return fail(e.message);
    throw e;
  }
  redirect(`/thanks${bill ? '' : '?bill=0'}`);
}
