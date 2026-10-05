import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { createDb } from './client';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

export async function runMigrations(url: string): Promise<void> {
  const { db, close } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await close();
  }
}
