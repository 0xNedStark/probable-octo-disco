'use client';

import { useActionState } from 'react';
import { confirmCode, sendCode, type AcceptState } from './actions';

export function AcceptPanel({
  token,
  bookingToken,
  policy,
  policyVersion,
}: {
  token: string;
  bookingToken: string;
  policy: string[];
  policyVersion: string;
}) {
  const [sent, send, sending] = useActionState(sendCode.bind(null, token), {
    step: 'agree',
  } as AcceptState);
  const [confirmed, confirm, confirming] = useActionState(confirmCode.bind(null, token), {
    step: 'code',
  } as AcceptState);
  const codeStep = sent.step === 'code';
  const error = codeStep ? (confirmed.error ?? null) : (sent.error ?? null);

  return (
    <div className="stack no-print">
      <h3>Accept this proposal and book your survey</h3>
      <p className="small">
        Booking token: <strong>{bookingToken}</strong>, adjusted against the system price.
      </p>
      <ul className="small">
        {policy.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {!codeStep ? (
        <form action={send} className="stack">
          <label className="check">
            <input type="checkbox" name="agree" />
            <span>
              I accept this proposal and the refund terms above{' '}
              <span className="muted">({policyVersion})</span>.
            </span>
          </label>
          <button type="submit" disabled={sending}>
            {sending ? 'Sending code…' : 'Send me a confirmation code'}
          </button>
        </form>
      ) : (
        <form action={confirm} className="stack">
          <p className="small">We sent a 6-digit code on WhatsApp to {sent.maskedPhone}.</p>
          <label htmlFor="code">Confirmation code</label>
          <input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            style={{ maxWidth: 160 }}
          />
          <button type="submit" disabled={confirming}>
            {confirming ? 'Confirming…' : 'Confirm and continue to payment'}
          </button>
        </form>
      )}
    </div>
  );
}
