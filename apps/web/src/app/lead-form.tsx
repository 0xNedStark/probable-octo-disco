'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { submitLead, type LeadFormState } from './actions';

const initial: LeadFormState = { error: null };

export function LeadForm() {
  const [state, action, pending] = useActionState(submitLead, initial);
  const v = state.values ?? {};
  return (
    <form action={action} className="stack" noValidate>
      {state.error && (
        <p className="alert error" role="alert">
          {state.error}
        </p>
      )}
      <div className="field-row">
        <div>
          <label htmlFor="name">Your name</label>
          <input id="name" name="name" required autoComplete="name" defaultValue={v.name} />
        </div>
        <div>
          <label htmlFor="phone">Mobile number</label>
          <input
            id="phone"
            name="phone"
            required
            inputMode="tel"
            autoComplete="tel"
            placeholder="98765 43210"
            defaultValue={v.phone}
          />
        </div>
      </div>
      <div className="field-row">
        <div>
          <label htmlFor="city">City / town</label>
          <input id="city" name="city" required defaultValue={v.city ?? 'Agra'} />
        </div>
        <div>
          <label htmlFor="pincode">PIN code (optional)</label>
          <input
            id="pincode"
            name="pincode"
            inputMode="numeric"
            maxLength={6}
            defaultValue={v.pincode}
          />
        </div>
      </div>
      <div className="field-row">
        <div>
          <label htmlFor="consumerNumber">DVVNL account number (optional)</label>
          <input id="consumerNumber" name="consumerNumber" defaultValue={v.consumerNumber} />
        </div>
        <div>
          <label htmlFor="monthlyBill">Typical monthly bill, ₹ (optional)</label>
          <input
            id="monthlyBill"
            name="monthlyBill"
            inputMode="numeric"
            defaultValue={v.monthlyBill}
          />
        </div>
      </div>
      <div>
        <label htmlFor="bill">Electricity bill — PDF or photo (optional, up to 10 MB)</label>
        <input
          id="bill"
          name="bill"
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
        />
      </div>
      <div className="hp" aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <label className="check">
        <input type="checkbox" name="consentContact" required />
        <span>
          I agree to be contacted about rooftop solar and accept the{' '}
          <Link href="/privacy" target="_blank">
            privacy notice
          </Link>
          .
        </span>
      </label>
      <label className="check">
        <input type="checkbox" name="consentWhatsapp" defaultChecked />
        <span>Send me updates on WhatsApp.</span>
      </label>
      <input type="hidden" name="source" value="web" />
      <button type="submit" disabled={pending}>
        {pending ? 'Sending…' : 'Get my free assessment'}
      </button>
    </form>
  );
}
