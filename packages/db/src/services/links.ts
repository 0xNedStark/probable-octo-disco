import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Customer status links are signed, not stored: token = <projectId>.<hmac>.
 * Links already sent on WhatsApp keep working; rotating STATUS_LINK_SECRET revokes all.
 */
function sign(projectId: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`status:${projectId}`)
    .digest('base64url')
    .slice(0, 32);
}

export function statusToken(projectId: string, secret: string): string {
  if (!secret) throw new Error('STATUS_LINK_SECRET is not set');
  return `${projectId}.${sign(projectId, secret)}`;
}

export function statusUrl(projectId: string, baseUrl: string, secret: string): string {
  return `${baseUrl.replace(/\/$/, '')}/s/${statusToken(projectId, secret)}`;
}

/** Returns the project id when the token is genuine, else null. */
export function verifyStatusToken(token: string, secret: string): string | null {
  const m = /^(prj_[0-9A-HJKMNP-TV-Z]{26})\.([A-Za-z0-9_-]{32})$/.exec(token);
  if (!m || !secret) return null;
  const expected = Buffer.from(sign(m[1]!, secret));
  const given = Buffer.from(m[2]!);
  return expected.length === given.length && timingSafeEqual(expected, given) ? m[1]! : null;
}
