import { claimOutbox, markFailed, markSent, type DbOrTx, type OutboxMessage } from '@solar/db';
import type { Notifier } from '@solar/integrations';

/** Background job handlers keyed by outbox template (channel 'internal'). */
export type JobHandlers = Record<string, (msg: OutboxMessage) => Promise<void>>;

/**
 * Deliver one batch of due outbox messages: customer notifications go to the
 * notifier, internal jobs to their handler. Returns how many were attempted.
 */
export async function dispatchOutbox(
  db: DbOrTx,
  notifier: Notifier,
  jobs: JobHandlers = {},
  batchSize = 20,
): Promise<number> {
  const batch = await claimOutbox(db, batchSize);
  for (const msg of batch) {
    try {
      if (msg.channel === 'internal') {
        const handler = jobs[msg.template];
        if (!handler) throw new Error(`No handler for job ${msg.template}`);
        await handler(msg);
      } else {
        await notifier.send(msg);
      }
      await markSent(db, msg.id);
    } catch (e) {
      await markFailed(db, msg, e instanceof Error ? e.message : String(e));
    }
  }
  return batch.length;
}
