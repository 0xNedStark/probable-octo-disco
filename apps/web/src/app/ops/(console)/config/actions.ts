'use server';

import { isConfigKind } from '@solar/calc';
import { publishConfig, ServiceError } from '@solar/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actorOf, requireStaff } from '@/lib/auth';
import { getDb } from '@/lib/db';

export async function publish(form: FormData) {
  const user = await requireStaff('config.manage');
  const kind = String(form.get('kind') ?? '');
  if (!isConfigKind(kind)) throw new Error('bad kind');
  let message: string;
  let ok = false;
  try {
    const body = JSON.parse(String(form.get('body') ?? ''));
    const r = await publishConfig(
      getDb(),
      actorOf(user),
      kind,
      body,
      String(form.get('note') ?? ''),
    );
    message = `Published ${kind} v${r.version}.`;
    ok = true;
  } catch (e) {
    if (e instanceof SyntaxError) message = `Not valid JSON: ${e.message}`;
    else if (e instanceof ServiceError) message = e.message;
    else throw e;
  }
  revalidatePath('/ops/config');
  redirect(`/ops/config?${ok ? 'ok' : 'error'}=${encodeURIComponent(message)}`);
}
