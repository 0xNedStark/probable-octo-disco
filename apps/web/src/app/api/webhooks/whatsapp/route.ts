import { recordInbound, ServiceError } from '@solar/db';
import { parseWhatsAppWebhook, verifyWhatsAppSignature } from '@solar/integrations';
import { getDb } from '@/lib/db';

/** Meta webhook verification handshake. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = process.env.WHATSAPP_VERIFY_TOKEN;
  if (
    token &&
    url.searchParams.get('hub.mode') === 'subscribe' &&
    url.searchParams.get('hub.verify_token') === token
  ) {
    return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
  }
  return new Response('forbidden', { status: 403 });
}

/** Inbound WhatsApp messages. Verified against the app secret before anything is stored. */
export async function POST(req: Request) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return new Response('whatsapp not configured', { status: 404 });
  const raw = await req.text();
  if (!verifyWhatsAppSignature(raw, req.headers.get('x-hub-signature-256'), secret)) {
    return new Response('invalid signature', { status: 401 });
  }
  let recorded = 0;
  for (const m of parseWhatsAppWebhook(raw)) {
    try {
      const r = await recordInbound(getDb(), m);
      if (!r.duplicate) recorded++;
    } catch (e) {
      // Non-Indian numbers etc.: acknowledge so Meta doesn't retry, and log.
      if (e instanceof ServiceError)
        console.warn(`[whatsapp] skipped ${m.providerMessageId}: ${e.message}`);
      else throw e;
    }
  }
  return Response.json({ recorded });
}
