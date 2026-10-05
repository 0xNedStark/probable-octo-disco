import 'server-only';
import { can, STAFF_ROLES, type Permission } from '@solar/domain';
import { getSessionUser, type ServiceActor, type SessionUser } from '@solar/db';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getDb } from './db';

export const SESSION_COOKIE = 'sid';

export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const user = await getSessionUser(getDb(), token);
  return user && STAFF_ROLES.includes(user.role) ? user : null;
});

/**
 * Gate for every ops page and server action. Server actions are public HTTP
 * endpoints, so each one must call this itself — layouts alone don't protect them.
 */
export async function requireStaff(permission: Permission = 'project.view'): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/ops/login');
  if (!can(user.role, permission)) redirect('/ops?error=' + encodeURIComponent('Not permitted.'));
  return user;
}

export function actorOf(user: SessionUser): ServiceActor {
  return { type: 'user', id: user.id, role: user.role };
}

export async function setSessionCookie(token: string, expires: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires,
  });
}
