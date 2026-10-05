import postgres from 'postgres';
import { runMigrations } from '../migrate';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://solar:solar@localhost:5432/solar_test';

/** Recreate the test schema from migrations once per run. */
export default async function setup(): Promise<void> {
  const sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await sql.unsafe(
    'drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;',
  );
  await sql.end();
  await runMigrations(TEST_DATABASE_URL);
}
