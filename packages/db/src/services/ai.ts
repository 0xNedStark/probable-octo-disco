import { newId } from '@solar/domain';
import { desc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../client';
import { aiActions } from '../schema';

export interface AiActionInput {
  projectId: string | null;
  agent: string;
  promptVersion: string;
  model: string;
  inputRef: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  outcome: 'ok' | 'refused' | 'invalid_output' | 'error' | 'skipped';
  error?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
}

/** Log a model call. Callers must pass references (ids), never raw document content. */
export async function logAiAction(db: DbOrTx, a: AiActionInput): Promise<string> {
  const id = newId('aiAction');
  await db.insert(aiActions).values({
    id,
    projectId: a.projectId,
    agent: a.agent,
    promptVersion: a.promptVersion,
    model: a.model,
    inputRef: a.inputRef,
    output: a.output ?? null,
    outcome: a.outcome,
    error: a.error?.slice(0, 2000) ?? null,
    inputTokens: a.inputTokens ?? null,
    outputTokens: a.outputTokens ?? null,
    latencyMs: a.latencyMs ?? null,
  });
  return id;
}

export async function listAiActions(db: DbOrTx, projectId: string) {
  return db
    .select()
    .from(aiActions)
    .where(eq(aiActions.projectId, projectId))
    .orderBy(desc(aiActions.createdAt))
    .limit(20);
}
