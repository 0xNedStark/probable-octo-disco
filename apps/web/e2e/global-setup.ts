import { createDb, createUser, seedConfig } from '@solar/db';
import { runMigrations } from '@solar/db/migrate';
import postgres from 'postgres';
import { E2E_DATABASE_URL } from '../playwright.config';

export const ADMIN = { email: 'e2e-admin@example.com', password: 'e2e-password-123' };

export default async function setup(): Promise<void> {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  await sql.unsafe(
    'drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;',
  );
  await sql.end();
  await runMigrations(E2E_DATABASE_URL);
  const { db, close } = createDb(E2E_DATABASE_URL, { max: 1 });
  await createUser(db, { ...ADMIN, name: 'E2E Admin', role: 'admin' });
  await seedConfig(db);
  await close();
}
