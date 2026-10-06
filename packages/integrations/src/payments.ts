import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface PaymentLinkRequest {
  /** Our payment id; echoed back by the provider as reference_id. */
  reference: string;
  amountPaise: number;
  description: string;
  customer: { name: string; phone: string };
  callbackUrl: string;
  expiresAt: Date;
}

export interface PaymentLink {
  providerRef: string;
  payUrl: string;
}

export type PaymentEventKind = 'paid' | 'expired' | 'cancelled' | 'ignored';

export interface PaymentEvent {
  eventId: string;
  type: string;
  kind: PaymentEventKind;
  reference: string | null;
  providerRef: string | null;
  providerPaymentId: string | null;
  amountPaise: number | null;
  method: string | null;
}

export interface PaymentProvider {
  readonly name: 'razorpay' | 'dev';
  createLink(req: PaymentLinkRequest): Promise<PaymentLink>;
  /** Verify and parse a webhook. Returns null when the signature is invalid. */
  parseWebhook(rawBody: string, headers: Headers): PaymentEvent | null;
}

function hmacHex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

interface RazorpayWebhook {
  event?: string;
  payload?: {
    payment_link?: {
      entity?: { id?: string; reference_id?: string; amount_paid?: number; amount?: number };
    };
    payment?: { entity?: { id?: string; amount?: number; method?: string } };
  };
}

/** Parse a Razorpay-format webhook body (also produced by the dev provider). */
export function parseRazorpayEvent(rawBody: string, eventId: string): PaymentEvent {
  const body = JSON.parse(rawBody) as RazorpayWebhook;
  const type = body.event ?? 'unknown';
  const link = body.payload?.payment_link?.entity;
  const payment = body.payload?.payment?.entity;
  const kind: PaymentEventKind =
    type === 'payment_link.paid'
      ? 'paid'
      : type === 'payment_link.expired'
        ? 'expired'
        : type === 'payment_link.cancelled'
          ? 'cancelled'
          : 'ignored';
  return {
    eventId,
    type,
    kind,
    reference: link?.reference_id ?? null,
    providerRef: link?.id ?? null,
    providerPaymentId: payment?.id ?? null,
    amountPaise: payment?.amount ?? link?.amount_paid ?? null,
    method: payment?.method ?? null,
  };
}

/** Razorpay Payment Links (https://razorpay.com/docs/api/payments/payment-links/). */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
    private readonly baseUrl = 'https://api.razorpay.com/v1',
  ) {}

  async createLink(req: PaymentLinkRequest): Promise<PaymentLink> {
    const res = await fetch(`${this.baseUrl}/payment_links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
      },
      body: JSON.stringify({
        amount: req.amountPaise,
        currency: 'INR',
        accept_partial: false,
        reference_id: req.reference,
        description: req.description,
        customer: { name: req.customer.name, contact: req.customer.phone },
        notify: { sms: false, email: false },
        reminder_enable: false,
        callback_url: req.callbackUrl,
        callback_method: 'get',
        expire_by: Math.floor(req.expiresAt.getTime() / 1000),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      short_url?: string;
      error?: { description?: string };
    };
    if (!res.ok || !json.id || !json.short_url) {
      throw new Error(
        `Razorpay ${res.status}: ${json.error?.description ?? 'payment link creation failed'}`,
      );
    }
    return { providerRef: json.id, payUrl: json.short_url };
  }

  parseWebhook(rawBody: string, headers: Headers): PaymentEvent | null {
    const signature = headers.get('x-razorpay-signature') ?? '';
    if (!safeEqualHex(hmacHex(this.webhookSecret, rawBody), signature)) return null;
    const eventId =
      headers.get('x-razorpay-event-id') ?? createHash('sha256').update(rawBody).digest('hex');
    return parseRazorpayEvent(rawBody, eventId);
  }
}

/**
 * Local/test provider: links point at our own /pay/dev page, whose "pay" button
 * produces a signed Razorpay-format webhook so the real webhook path is exercised.
 * Never enable in production.
 */
export class DevPaymentProvider implements PaymentProvider {
  readonly name = 'dev' as const;
  constructor(
    private readonly publicBaseUrl: string,
    private readonly webhookSecret: string,
  ) {}

  async createLink(req: PaymentLinkRequest): Promise<PaymentLink> {
    return {
      providerRef: `plink_dev_${req.reference}`,
      payUrl: `${this.publicBaseUrl.replace(/\/$/, '')}/pay/dev/${req.reference}`,
    };
  }

  /** Build the signed webhook a real gateway would send after a successful payment. */
  simulatePaid(reference: string, amountPaise: number): { body: string; headers: Headers } {
    const body = JSON.stringify({
      event: 'payment_link.paid',
      payload: {
        payment_link: {
          entity: {
            id: `plink_dev_${reference}`,
            reference_id: reference,
            amount_paid: amountPaise,
            status: 'paid',
          },
        },
        payment: {
          entity: {
            id: `pay_dev_${reference}`,
            amount: amountPaise,
            method: 'upi',
            status: 'captured',
          },
        },
      },
    });
    const headers = new Headers({
      'x-razorpay-signature': hmacHex(this.webhookSecret, body),
      'x-razorpay-event-id': `evt_dev_${reference}`,
    });
    return { body, headers };
  }

  parseWebhook(rawBody: string, headers: Headers): PaymentEvent | null {
    const signature = headers.get('x-razorpay-signature') ?? '';
    if (!safeEqualHex(hmacHex(this.webhookSecret, rawBody), signature)) return null;
    return parseRazorpayEvent(rawBody, headers.get('x-razorpay-event-id') ?? 'unknown');
  }
}

/** PAYMENTS_PROVIDER=razorpay|dev; returns null when payments are not configured. */
export function paymentProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PaymentProvider | null {
  const secret = env.PAYMENTS_WEBHOOK_SECRET;
  if (env.PAYMENTS_PROVIDER === 'razorpay') {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !secret) {
      throw new Error(
        'RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and PAYMENTS_WEBHOOK_SECRET are required',
      );
    }
    return new RazorpayProvider(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, secret);
  }
  if (env.PAYMENTS_PROVIDER === 'dev') {
    if (env.NODE_ENV === 'production' && env.ALLOW_DEV_PAYMENTS !== '1') {
      throw new Error('The dev payment provider is disabled in production');
    }
    if (!env.PUBLIC_BASE_URL || !secret)
      throw new Error('PUBLIC_BASE_URL and PAYMENTS_WEBHOOK_SECRET are required');
    return new DevPaymentProvider(env.PUBLIC_BASE_URL, secret);
  }
  return null;
}
