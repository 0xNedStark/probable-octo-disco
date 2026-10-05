import { claimOutbox, markFailed, markSent, type DbOrTx } from '@solar/db';
import type { Notifier } from '@solar/integrations';

/** Deliver one batch of due outbox messages. Returns how many were attempted. */
export async function dispatchOutbox(
  db: DbOrTx,
  notifier: Notifier,
  batchSize = 20,
): Promise<number> {
  const batch = await claimOutbox(db, batchSize);
  for (const msg of batch) {
    try {
      await notifier.send(msg);
      await markSent(db, msg.id);
    } catch (e) {
      await markFailed(db, msg, e instanceof Error ? e.message : String(e));
    }
  }
  return batch.length;
}
