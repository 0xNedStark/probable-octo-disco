import {
  eq,
  logAiAction,
  recordBillExtraction,
  schema,
  type DbOrTx,
  type OutboxMessage,
} from '@solar/db';
import type { ClaudeBillExtractor, Storage } from '@solar/integrations';
import type { JobHandlers } from './dispatch';

export interface JobDeps {
  db: DbOrTx;
  storage: Storage;
  /** null when AI extraction is switched off; bills then wait for manual entry. */
  billExtractor: Pick<ClaudeBillExtractor, 'extract'> | null;
  confidenceThreshold: number;
  log?: (line: string) => void;
}

type MediaType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

export function jobHandlers(deps: JobDeps): JobHandlers {
  const log = deps.log ?? console.log;
  return {
    'bill.extract': async (msg: OutboxMessage) => {
      const billId = String(msg.payload.billId ?? '');
      if (!deps.billExtractor) {
        log(`[bill.extract] AI extraction off; ${billId} left for manual entry`);
        return;
      }
      const [bill] = await deps.db
        .select()
        .from(schema.electricityBills)
        .where(eq(schema.electricityBills.id, billId));
      if (!bill) throw new Error(`Bill ${billId} not found`);
      const body = await deps.storage.get(bill.storageKey);
      const r = await deps.billExtractor.extract(body, bill.contentType as MediaType);
      const aiActionId = await logAiAction(deps.db, {
        projectId: bill.projectId,
        agent: 'bill-agent',
        promptVersion: r.promptVersion,
        model: r.model,
        inputRef: { billId, sha256: bill.sha256 },
        output: r.extraction ? { ...r.extraction } : null,
        outcome: r.outcome,
        error: r.error,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        latencyMs: r.latencyMs,
      });
      const res = await recordBillExtraction(deps.db, bill.projectId, billId, r.extraction, {
        threshold: deps.confidenceThreshold,
        aiActionId,
        failure: r.outcome === 'ok' ? undefined : `Automatic reading failed (${r.outcome}).`,
      });
      log(
        `[bill.extract] ${billId}: ${r.outcome} → ${res.state}${res.problems.length ? ` (${res.problems.join(' ')})` : ''}`,
      );
    },
  };
}
