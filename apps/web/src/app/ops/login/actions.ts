'use server';

import { authenticate, createSession, deleteSession } from '@solar/db';
import { STAFF_ROLES } from '@solar/domain';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, setSessionCookie } from '@/lib/auth';
import { getDb } from '@/lib/db';

export async function login(form: FormData): Promise<void> {
  const email = String(form.get('email') ?? '');
  const password = String(form.get('password') ?? '');
  const user = await authenticate(getDb(), email, password);
  if (!user || !STAFF_ROLES.includes(user.role)) redirect('/ops/login?error=1');
  const { token, expiresAt } = await createSession(getDb(), user.id);
  await setSessionCookie(token, expiresAt);
  redirect('/ops');
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(getDb(), token);
  jar.delete(SESSION_COOKIE);
  redirect('/ops/login');
}
