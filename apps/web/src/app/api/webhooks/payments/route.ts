import { processPaymentEvent } from '@solar/db';
import { getDb } from '@/lib/db';
import { getPaymentProvider } from '@/lib/payments';

/** Payment gateway webhook. The raw body is verified before anything is parsed or stored. */
export async function POST(req: Request) {
  const provider = getPaymentProvider();
  if (!provider) return new Response('payments not configured', { status: 404 });
  const raw = await req.text();
  const event = provider.parseWebhook(raw, req.headers);
  if (!event) return new Response('invalid signature', { status: 401 });
  const result = await processPaymentEvent(
    getDb(),
    provider.name,
    event,
    JSON.parse(raw) as Record<string, unknown>,
  );
  if (result.outcome === 'rejected')
    console.warn(`[payments] webhook ${event.eventId} rejected: ${result.detail}`);
  // 200 for every verified event so the gateway stops retrying; problems become ops tasks.
  return Response.json(result);
}
