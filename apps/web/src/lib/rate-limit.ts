import 'server-only';

/**
 * Fixed-window in-memory limiter. Per server instance only — adequate for the
 * pilot's single instance; move to Postgres/Redis before scaling out.
 */
const windows = new Map<string, { start: number; count: number }>();

export function allowRequest(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 10_000) {
      for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
    }
    return true;
  }
  w.count += 1;
  return w.count <= limit;
}
