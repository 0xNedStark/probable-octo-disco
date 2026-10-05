import { newId } from '@solar/domain';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '../client';
import { createUser } from '../services/auth';
import { seedConfig } from '../services/config';
import type { ServiceActor } from '../services/common';
import { createLead, type CreateLeadInput } from '../services/leads';
import { TEST_DATABASE_URL } from './global-setup';

export function testDb() {
  return createDb(TEST_DATABASE_URL, { max: 4 });
}

/**
 * Wipe all data and re-seed config. The append-only triggers block DELETE, so
 * TRUNCATE (which bypasses row triggers).
 */
export async function reset(db: Db): Promise<void> {
  await db.execute(sql`
    truncate table config_versions, ai_actions, solar_quotes, file_access_log, outbox, tasks, project_facts, project_events, bill_readings,
      electricity_bills, solar_projects, leads, consents, customers, sessions, users
    restart identity cascade
  `);
  await db.execute(sql`alter sequence project_code_seq restart`);
  await seedConfig(db);
}

export async function staff(db: Db, role: 'admin' | 'ops' | 'sales' | 'engineer' | 'finance') {
  const id = await createUser(db, {
    email: `${role}-${newId('user')}@example.com`,
    name: role,
    role,
    password: 'correct horse battery',
  });
  return { type: 'user', id, role } as const satisfies ServiceActor;
}

export function leadInput(overrides: Partial<CreateLeadInput> = {}): CreateLeadInput {
  return {
    name: 'Asha Verma',
    phone: '98765 43210',
    city: 'Agra',
    source: 'web',
    consent: { contact: true, whatsapp: true, textVersion: 'v1', channel: 'web' },
    bill: {
      id: newId('bill'),
      storageKey: 'bills/test.pdf',
      originalFilename: 'bill.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1234,
      sha256: 'abc123',
    },
    ...overrides,
  };
}

export async function seedLead(db: Db, overrides: Partial<CreateLeadInput> = {}) {
  return createLead(db, leadInput(overrides));
}
