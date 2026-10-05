import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../client';
import { outbox } from '../schema';

export type OutboxMessage = typeof outbox.$inferSelect;

const MAX_ATTEMPTS = 8;
/** A message stuck in 'processing' this long (worker crashed) is picked up again. */
const STALE_LOCK = sql`interval '10 minutes'`;

/** Atomically claim up to `limit` due messages. Safe with several workers (SKIP LOCKED). */
export async function claimOutbox(db: DbOrTx, limit = 20): Promise<OutboxMessage[]> {
  return db.execute<OutboxMessage>(sql`
    update ${outbox}
    set status = 'processing', attempts = attempts + 1, locked_at = now()
    where id in (
      select id from ${outbox}
      where (status = 'pending' and available_at <= now())
         or (status = 'processing' and locked_at < now() - ${STALE_LOCK})
      order by created_at
      limit ${limit}
      for update skip locked
    )
    returning
      id, project_id as "projectId", channel, template, recipient, payload, status, attempts,
      available_at as "availableAt", locked_at as "lockedAt", last_error as "lastError",
      sent_at as "sentAt", created_at as "createdAt"
  `) as unknown as Promise<OutboxMessage[]>;
}

export async function markSent(db: DbOrTx, id: string): Promise<void> {
  await db
    .update(outbox)
    .set({ status: 'sent', sentAt: new Date(), lockedAt: null, lastError: null })
    .where(eq(outbox.id, id));
}

/** Exponential backoff (1, 2, 4 … minutes); gives up after MAX_ATTEMPTS. */
export async function markFailed(db: DbOrTx, msg: OutboxMessage, error: string): Promise<void> {
  const giveUp = msg.attempts >= MAX_ATTEMPTS;
  await db
    .update(outbox)
    .set({
      status: giveUp ? 'failed' : 'pending',
      lockedAt: null,
      lastError: error.slice(0, 2000),
      availableAt: new Date(Date.now() + 2 ** (msg.attempts - 1) * 60_000),
    })
    .where(eq(outbox.id, msg.id));
}
