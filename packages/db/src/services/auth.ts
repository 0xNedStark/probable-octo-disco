import { isRole, newId, type Role } from '@solar/domain';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../client';
import { sessions, users } from '../schema';
import { ServiceError } from './common';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(actual, expected);
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export async function createUser(
  db: DbOrTx,
  input: { email: string; name: string; role: Role; password: string },
): Promise<string> {
  if (!isRole(input.role)) throw new ServiceError('INVALID', 'Unknown role.');
  if (input.password.length < 12) {
    throw new ServiceError('INVALID', 'Password must be at least 12 characters.');
  }
  const id = newId('user');
  await db.insert(users).values({
    id,
    email: input.email.trim().toLowerCase(),
    name: input.name.trim(),
    role: input.role,
    passwordHash: await hashPassword(input.password),
  });
  return id;
}

// Compared against when the email is unknown so response time doesn't reveal which emails exist.
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));

/** Returns the user on success, null on any failure. Locks the account after repeated failures. */
export async function authenticate(
  db: DbOrTx,
  email: string,
  password: string,
): Promise<SessionUser | null> {
  const [u] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
  if (!u || !u.active) {
    await verifyPassword(password, await DUMMY_HASH);
    return null;
  }
  if (u.lockedUntil && u.lockedUntil > new Date()) return null;

  if (!(await verifyPassword(password, u.passwordHash))) {
    const failed = u.failedLogins + 1;
    await db
      .update(users)
      .set({
        failedLogins: failed >= MAX_FAILED_LOGINS ? 0 : failed,
        lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MS) : null,
      })
      .where(eq(users.id, u.id));
    return null;
  }
  if (u.failedLogins > 0 || u.lockedUntil) {
    await db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, u.id));
  }
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Returns the raw token for the cookie; only its hash is stored. */
export async function createSession(
  db: DbOrTx,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db
    .insert(sessions)
    .values({ id: newId('session'), userId, tokenHash: hashToken(token), expiresAt });
  return { token, expiresAt };
}

export async function getSessionUser(db: DbOrTx, token: string): Promise<SessionUser | null> {
  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, sql`now()`),
        eq(users.active, true),
      ),
    );
  return row ?? null;
}

export async function deleteSession(db: DbOrTx, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}
