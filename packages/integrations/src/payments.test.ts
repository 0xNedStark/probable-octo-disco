import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevPaymentProvider, paymentProviderFromEnv, RazorpayProvider } from './payments';

const body = JSON.stringify({
  event: 'payment_link.paid',
  payload: {
    payment_link: { entity: { id: 'plink_1', reference_id: 'pay_ours', amount_paid: 500000 } },
    payment: { entity: { id: 'pay_rzp', amount: 500000, method: 'upi' } },
  },
});
const sign = (secret: string, b: string) => createHmac('sha256', secret).update(b).digest('hex');

describe('RazorpayProvider', () => {
  afterEach(() => vi.unstubAllGlobals());
  const rzp = new RazorpayProvider('key', 'secret', 'whsec');

  it('verifies the webhook signature and parses payment_link.paid', () => {
    const headers = new Headers({
      'x-razorpay-signature': sign('whsec', body),
      'x-razorpay-event-id': 'evt_1',
    });
    expect(rzp.parseWebhook(body, headers)).toEqual({
      eventId: 'evt_1',
      type: 'payment_link.paid',
      kind: 'paid',
      reference: 'pay_ours',
      providerRef: 'plink_1',
      providerPaymentId: 'pay_rzp',
      amountPaise: 500000,
      method: 'upi',
    });
  });

  it('rejects bad or missing signatures', () => {
    expect(
      rzp.parseWebhook(body, new Headers({ 'x-razorpay-signature': sign('other', body) })),
    ).toBeNull();
    expect(rzp.parseWebhook(body, new Headers())).toBeNull();
    expect(
      rzp.parseWebhook(body + ' ', new Headers({ 'x-razorpay-signature': sign('whsec', body) })),
    ).toBeNull();
  });

  it('creates payment links with basic auth and the reference id', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'plink_9', short_url: 'https://rzp.io/x' }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const link = await rzp.createLink({
      reference: 'pay_ours',
      amountPaise: 500000,
      description: 'Booking',
      customer: { name: 'A', phone: '+919876543210' },
      callbackUrl: 'https://x.test/pay/return',
      expiresAt: new Date('2026-10-10T00:00:00Z'),
    });
    expect(link).toEqual({ providerRef: 'plink_9', payUrl: 'https://rzp.io/x' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.com/v1/payment_links');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('key:secret').toString('base64')}`,
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      amount: 500000,
      currency: 'INR',
      reference_id: 'pay_ours',
      expire_by: 1791590400,
    });
  });

  it('surfaces API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { description: 'bad key' } }), { status: 401 }),
      ),
    );
    await expect(
      rzp.createLink({
        reference: 'r',
        amountPaise: 1,
        description: 'd',
        customer: { name: 'a', phone: 'p' },
        callbackUrl: 'c',
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(/401: bad key/);
  });
});

describe('DevPaymentProvider', () => {
  it('simulated webhooks pass verification and parse like Razorpay', async () => {
    const dev = new DevPaymentProvider('http://localhost:3000/', 'devsecret');
    const link = await dev.createLink({
      reference: 'pay_x',
      amountPaise: 100,
      description: '',
      customer: { name: '', phone: '' },
      callbackUrl: '',
      expiresAt: new Date(),
    });
    expect(link.payUrl).toBe('http://localhost:3000/pay/dev/pay_x');
    const { body: b, headers } = dev.simulatePaid('pay_x', 100);
    expect(dev.parseWebhook(b, headers)).toMatchObject({
      kind: 'paid',
      reference: 'pay_x',
      amountPaise: 100,
      eventId: 'evt_dev_pay_x',
    });
    expect(new DevPaymentProvider('x', 'other').parseWebhook(b, headers)).toBeNull();
  });
});

describe('paymentProviderFromEnv', () => {
  it('selects providers and refuses dev payments in production', () => {
    expect(paymentProviderFromEnv({})).toBeNull();
    expect(
      paymentProviderFromEnv({
        PAYMENTS_PROVIDER: 'dev',
        PUBLIC_BASE_URL: 'x',
        PAYMENTS_WEBHOOK_SECRET: 's',
      })?.name,
    ).toBe('dev');
    expect(() =>
      paymentProviderFromEnv({
        PAYMENTS_PROVIDER: 'dev',
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'x',
        PAYMENTS_WEBHOOK_SECRET: 's',
      }),
    ).toThrow(/disabled in production/);
    expect(() => paymentProviderFromEnv({ PAYMENTS_PROVIDER: 'razorpay' })).toThrow(/required/);
  });
});
