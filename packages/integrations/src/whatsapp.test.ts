import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWhatsAppBody,
  MetaWhatsApp,
  parseWhatsAppWebhook,
  verifyWhatsAppSignature,
} from './whatsapp';

const msg = (template: string, payload: Record<string, unknown>) => ({
  id: 'obx_1',
  projectId: 'prj_1',
  channel: 'whatsapp',
  template,
  recipient: '+919876543210',
  payload,
});

describe('buildWhatsAppBody', () => {
  it('maps templates to approved names with ordered parameters', () => {
    const b = buildWhatsAppBody(
      msg('quote_sent', {
        customerName: 'Asha Verma',
        systemKw: 3,
        subsidyPaise: 10_800_000,
        url: 'https://x/p/t',
      }),
      { statusUrl: null },
    );
    expect(b).toMatchObject({
      to: '919876543210',
      type: 'template',
      template: { name: 'proposal_ready_v1', language: { code: 'en' } },
    });
    const params = (
      b.template as { components: { parameters: { text: string }[] }[] }
    ).components[0]!.parameters.map((p) => p.text);
    expect(params).toEqual(['Asha', '3', '₹1,08,000', 'https://x/p/t']);
  });

  it('adds the copy-code button for OTPs and sends free text replies', () => {
    const otp = buildWhatsAppBody(msg('otp', { code: '123456' }), { statusUrl: null });
    expect((otp.template as { components: unknown[] }).components).toHaveLength(2);
    expect(
      buildWhatsAppBody(msg('reply', { text: 'Namaste!' }), { statusUrl: null }),
    ).toMatchObject({ type: 'text', text: { body: 'Namaste!' } });
    expect(() => buildWhatsAppBody(msg('nope', {}), { statusUrl: null })).toThrow(
      /No WhatsApp template/,
    );
  });
});

describe('webhooks', () => {
  const raw = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: '919876543210', profile: { name: 'Asha' } }],
              messages: [
                {
                  id: 'wamid.1',
                  from: '919876543210',
                  type: 'text',
                  text: { body: 'Solar lagwana hai' },
                },
                {
                  id: 'wamid.2',
                  from: '919876543210',
                  type: 'image',
                  image: { id: 'media1', mime_type: 'image/jpeg', caption: 'bill' },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  it('verifies X-Hub-Signature-256 and parses messages', () => {
    const sig = `sha256=${createHmac('sha256', 'appsecret').update(raw).digest('hex')}`;
    expect(verifyWhatsAppSignature(raw, sig, 'appsecret')).toBe(true);
    expect(verifyWhatsAppSignature(raw, sig, 'wrong')).toBe(false);
    expect(verifyWhatsAppSignature(raw, null, 'appsecret')).toBe(false);
    expect(parseWhatsAppWebhook(raw)).toEqual([
      {
        providerMessageId: 'wamid.1',
        from: '+919876543210',
        profileName: 'Asha',
        kind: 'text',
        text: 'Solar lagwana hai',
        mediaId: null,
        mimeType: null,
      },
      {
        providerMessageId: 'wamid.2',
        from: '+919876543210',
        profileName: 'Asha',
        kind: 'image',
        text: 'bill',
        mediaId: 'media1',
        mimeType: 'image/jpeg',
      },
    ]);
    expect(
      parseWhatsAppWebhook(
        JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] }),
      ),
    ).toEqual([]);
  });
});

describe('MetaWhatsApp', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts to the Cloud API and returns the message id with the status link filled in', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const wa = new MetaWhatsApp('PHONEID', 'TOKEN', (id) => (id ? `https://x/s/${id}` : null));
    const r = await wa.send(msg('payment_received', { customerName: 'Asha', amountPaise: 500000 }));
    expect(r).toEqual({
      providerMessageId: 'wamid.out',
      rendered: '[payment_received_v1] Asha | ₹5,000 | https://x/s/prj_1',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/PHONEID/messages');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN');
  });

  it('throws on API errors so the outbox retries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'template not approved' } }), {
            status: 400,
          }),
      ),
    );
    await expect(
      new MetaWhatsApp('P', 'T', () => null).send(msg('lead_received', {})),
    ).rejects.toThrow(/template not approved/);
  });
});
