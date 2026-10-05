import 'server-only';
import { createDb, type DbHandle } from '@solar/db';

const g = globalThis as unknown as { __solarDb?: DbHandle };

/** One pool per server process (survives dev hot reloads). */
export function getDb() {
  if (!g.__solarDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    g.__solarDb = createDb(url);
  }
  return g.__solarDb.db;
}
