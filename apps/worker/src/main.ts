import { createDb } from '@solar/db';
import { billExtractorFromEnv, LogNotifier, storageFromEnv } from '@solar/integrations';
import { setTimeout as sleep } from 'node:timers/promises';
import { dispatchOutbox } from './dispatch';
import { jobHandlers } from './jobs';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const POLL_MS = Number(process.env.OUTBOX_POLL_MS ?? 2000);
const { db, close } = createDb(url, { max: 2 });
const notifier = new LogNotifier();
const billExtractor = billExtractorFromEnv();
const jobs = jobHandlers({
  db,
  storage: storageFromEnv(),
  billExtractor,
  confidenceThreshold: Number(process.env.AI_BILL_CONFIDENCE_THRESHOLD ?? 0.9),
});
const controller = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => controller.abort());
}

console.log(
  `worker started; polling outbox every ${POLL_MS}ms; bill extraction ${billExtractor ? 'on' : 'off'}`,
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
