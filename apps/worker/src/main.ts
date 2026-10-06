import { createDb, statusUrl } from '@solar/db';
import {
  billExtractorFromEnv,
  DevWhatsAppMedia,
  LogNotifier,
  MetaWhatsApp,
  salesAgentFromEnv,
  storageFromEnv,
  type Notifier,
  type WhatsAppMedia,
} from '@solar/integrations';
import { setTimeout as sleep } from 'node:timers/promises';
import { dispatchOutbox } from './dispatch';
import { jobHandlers } from './jobs';

const env = process.env;
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

const POLL_MS = Number(env.OUTBOX_POLL_MS ?? 2000);
const { db, close } = createDb(env.DATABASE_URL, { max: 2 });
const base = env.PUBLIC_BASE_URL ?? null;
const secret = env.STATUS_LINK_SECRET ?? null;
const statusLink = (projectId: string | null) =>
  projectId && base && secret ? statusUrl(projectId, base, secret) : null;

let notifier: Notifier;
let media: WhatsAppMedia | null;
if (env.WHATSAPP_PROVIDER === 'meta') {
  if (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are required');
  }
  const wa = new MetaWhatsApp(
    env.WHATSAPP_PHONE_NUMBER_ID,
    env.WHATSAPP_ACCESS_TOKEN,
    statusLink,
    env.WHATSAPP_GRAPH_VERSION || undefined,
  );
  notifier = wa;
  media = wa;
} else {
  notifier = new LogNotifier();
  media = new DevWhatsAppMedia();
}

const billExtractor = billExtractorFromEnv();
const salesAgent = salesAgentFromEnv();
const jobs = jobHandlers({
  db,
  storage: storageFromEnv(),
  billExtractor,
  confidenceThreshold: Number(env.AI_BILL_CONFIDENCE_THRESHOLD ?? 0.9),
  salesAgent,
  media,
  links: { statusUrl: statusLink, privacyUrl: base ? `${base.replace(/\/$/, '')}/privacy` : null },
});
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());

console.log(
  `worker started; polling every ${POLL_MS}ms; whatsapp ${env.WHATSAPP_PROVIDER === 'meta' ? 'meta' : 'log only'}; ` +
    `bill agent ${billExtractor ? 'on' : 'off'}; sales agent ${salesAgent ? 'on' : 'off'}`,
);
while (!controller.signal.aborted) {
  try {
    const n = await dispatchOutbox(db, notifier, jobs);
    if (n > 0) continue; // drain backlog without waiting
  } catch (e) {
    console.error('outbox dispatch failed', e);
  }
  await sleep(POLL_MS, undefined, { signal: controller.signal }).catch(() => {});
}
await close();
console.log('worker stopped');
