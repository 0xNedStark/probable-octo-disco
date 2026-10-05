import {
  CONFIG_KINDS,
  CONFIG_SCHEMAS,
  hashConfig,
  UP_DVVNL_SEED,
  type ConfigBundle,
  type ConfigKind,
  type ConfigVersions,
} from '@solar/calc';
import { newId } from '@solar/domain';
import { desc, eq, inArray, max } from 'drizzle-orm';
import type { DbOrTx } from '../client';
import { configVersions } from '../schema';
import { authorize, ServiceError, type ServiceActor } from './common';

type ConfigRow = typeof configVersions.$inferSelect;

export interface LoadedConfig {
  bundle: ConfigBundle;
  ids: Record<ConfigKind, string>;
  /** Human-readable labels, e.g. pricebook@3, used as assumption sources. */
  labels: ConfigVersions;
  hash: string;
  rows: Record<ConfigKind, ConfigRow>;
}

function assemble(rows: ConfigRow[]): LoadedConfig {
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  const missing = CONFIG_KINDS.filter((k) => !byKind.has(k));
  if (missing.length) {
    throw new ServiceError(
      'CONFLICT',
      `Configuration missing for: ${missing.join(', ')}. Run pnpm db:seed.`,
    );
  }
  const get = (k: ConfigKind) => byKind.get(k)!;
  const bundle = Object.fromEntries(
    CONFIG_KINDS.map((k) => [k, CONFIG_SCHEMAS[k].parse(get(k).body)]),
  ) as unknown as ConfigBundle;
  return {
    bundle,
    ids: Object.fromEntries(CONFIG_KINDS.map((k) => [k, get(k).id])) as Record<ConfigKind, string>,
    labels: Object.fromEntries(
      CONFIG_KINDS.map((k) => [k, `${k}@${get(k).version}`]),
    ) as ConfigVersions,
    hash: hashConfig(bundle),
    rows: Object.fromEntries(CONFIG_KINDS.map((k) => [k, get(k)])) as Record<ConfigKind, ConfigRow>,
  };
}

/** The latest published version of each config kind. */
export async function activeConfig(db: DbOrTx): Promise<LoadedConfig> {
  const rows = await db
    .selectDistinctOn([configVersions.kind])
    .from(configVersions)
    .orderBy(configVersions.kind, desc(configVersions.version));
  return assemble(rows);
}

/** Exactly the versions a quote was computed with. */
export async function configByIds(
  db: DbOrTx,
  ids: Record<ConfigKind, string>,
): Promise<LoadedConfig> {
  const rows = await db
    .select()
    .from(configVersions)
    .where(inArray(configVersions.id, Object.values(ids)));
  return assemble(rows);
}

export async function configHistory(db: DbOrTx, kind: ConfigKind) {
  return db
    .select()
    .from(configVersions)
    .where(eq(configVersions.kind, kind))
    .orderBy(desc(configVersions.version))
    .limit(20);
}

async function insertVersion(
  db: DbOrTx,
  kind: ConfigKind,
  body: unknown,
  note: string,
  createdBy: string | null,
): Promise<{ id: string; version: number }> {
  const parsed = CONFIG_SCHEMAS[kind].safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ServiceError(
      'INVALID',
      `Invalid ${kind} config at ${issue?.path.join('.') || '(root)'}: ${issue?.message}`,
    );
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ v: max(configVersions.version) })
      .from(configVersions)
      .where(eq(configVersions.kind, kind));
    const version = (row?.v ?? 0) + 1;
    const id = newId('config');
    await tx.insert(configVersions).values({
      id,
      kind,
      version,
      body: parsed.data as Record<string, unknown>,
      bodyHash: hashConfig(parsed.data),
      note: note.trim(),
      createdBy,
    });
    return { id, version };
  });
}

/** Publish a new version. Admin only; the body is validated against the schema. */
export async function publishConfig(
  db: DbOrTx,
  actor: ServiceActor,
  kind: ConfigKind,
  body: unknown,
  note: string,
): Promise<{ id: string; version: number }> {
  authorize(actor, 'config.manage');
  if (!note.trim()) throw new ServiceError('INVALID', 'Describe what changed and why.');
  return insertVersion(db, kind, body, note, actor.type === 'user' ? actor.id : null);
}

/** Insert the UP/DVVNL seed for any kind that has no versions yet. Idempotent. */
export async function seedConfig(db: DbOrTx): Promise<ConfigKind[]> {
  const existing = await db.selectDistinct({ kind: configVersions.kind }).from(configVersions);
  const have = new Set(existing.map((r) => r.kind));
  const seeded: ConfigKind[] = [];
  for (const kind of CONFIG_KINDS) {
    if (have.has(kind)) continue;
    await insertVersion(
      db,
      kind,
      UP_DVVNL_SEED[kind],
      'Initial UP/DVVNL seed (see packages/calc/src/seed.ts)',
      null,
    );
    seeded.push(kind);
  }
  return seeded;
}
