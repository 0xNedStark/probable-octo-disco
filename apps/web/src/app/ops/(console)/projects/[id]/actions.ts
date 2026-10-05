'use server';

import {
  acceptQuote,
  attachBill,
  generateQuote,
  sendQuote,
  completeTask,
  enterBillReadings,
  recordFact,
  requestBillResubmit,
  ServiceError,
  transitionStage,
  transitionWorkstream,
  type MonthlyUsage,
  type TransitionOutcome,
} from '@solar/db';
import { isFact, isStage, isWorkstream, isWorkstreamState, newId } from '@solar/domain';
import { checkBillFile, sha256 } from '@solar/integrations';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actorOf, requireStaff } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getStorage } from '@/lib/storage';

const str = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

/**
 * Run a service call and redirect back to the project with a flash message.
 * redirect() throws, so it must stay outside the try/catch.
 */
async function run(
  projectId: string,
  ok: string | (() => string),
  fn: () => Promise<TransitionOutcome | void>,
): Promise<never> {
  let error: string | undefined;
  try {
    const r = await fn();
    if (r && !r.ok) error = r.error.message;
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e;
    error = e.message;
  }
  revalidatePath(`/ops/projects/${projectId}`);
  const q = error
    ? `error=${encodeURIComponent(error)}`
    : `ok=${encodeURIComponent(typeof ok === 'function' ? ok() : ok)}`;
  redirect(`/ops/projects/${projectId}?${q}`);
}

export async function moveStage(projectId: string, form: FormData) {
  const user = await requireStaff('project.transition');
  const to = str(form, 'to');
  if (!isStage(to)) throw new Error('bad stage');
  await run(projectId, `Moved to ${to}.`, () =>
    transitionStage(getDb(), actorOf(user), projectId, to, str(form, 'reason') || undefined),
  );
}

export async function moveWorkstream(projectId: string, form: FormData) {
  const user = await requireStaff('workstream.transition');
  const w = str(form, 'workstream');
  const to = str(form, 'to');
  if (!isWorkstream(w) || !isWorkstreamState(w, to)) throw new Error('bad workstream');
  await run(projectId, `${w} → ${to}.`, () =>
    transitionWorkstream(
      getDb(),
      actorOf(user),
      projectId,
      w,
      to,
      str(form, 'reason') || undefined,
    ),
  );
}

export async function attestFact(projectId: string, form: FormData) {
  const user = await requireStaff();
  const fact = str(form, 'fact');
  if (!isFact(fact)) throw new Error('bad fact');
  const value = str(form, 'value') === 'true';
  await run(projectId, 'Recorded.', () =>
    recordFact(getDb(), actorOf(user), projectId, fact, value, str(form, 'note')),
  );
}

/** Parses lines like "2026-07: 450" into monthly history. */
function parseHistory(text: string): MonthlyUsage[] {
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [month = '', units = ''] = line.split(/[:=,\s]+/);
      return { month, units: Number(units) };
    });
}

export async function saveReadings(projectId: string, form: FormData) {
  const user = await requireStaff('bill.enter_readings');
  await run(projectId, 'Bill readings saved.', () =>
    enterBillReadings(
      getDb(),
      actorOf(user),
      projectId,
      {
        billId: str(form, 'billId'),
        consumerNumber: str(form, 'consumerNumber'),
        discom: str(form, 'discom'),
        tariffCategory: str(form, 'tariffCategory'),
        sanctionedLoadKw: Number(str(form, 'sanctionedLoadKw')),
        periodStart: str(form, 'periodStart'),
        periodEnd: str(form, 'periodEnd'),
        unitsKwh: Number(str(form, 'unitsKwh')),
        amountRupees: Number(str(form, 'amountRupees')),
        monthlyHistory: parseHistory(str(form, 'monthlyHistory')),
      },
      { proposedReadingId: str(form, 'proposedReadingId') || undefined },
    ),
  );
}

export async function askForNewBill(projectId: string, form: FormData) {
  const user = await requireStaff('bill.enter_readings');
  await run(projectId, 'Customer will be asked for a clearer bill.', () =>
    requestBillResubmit(getDb(), actorOf(user), projectId, str(form, 'reason')),
  );
}

export async function uploadBill(projectId: string, form: FormData) {
  const user = await requireStaff('bill.enter_readings');
  const file = form.get('bill');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`/ops/projects/${projectId}?error=${encodeURIComponent('Choose a file to upload.')}`);
  }
  const body = new Uint8Array(await file.arrayBuffer());
  const check = checkBillFile(body);
  if (!check.ok) redirect(`/ops/projects/${projectId}?error=${encodeURIComponent(check.error)}`);
  const id = newId('bill');
  const now = new Date();
  const storageKey = `bills/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.${check.ext}`;
  await getStorage().put(storageKey, body, check.contentType);
  await run(projectId, 'Bill uploaded.', () =>
    attachBill(getDb(), actorOf(user), projectId, {
      id,
      storageKey,
      originalFilename: file.name.slice(0, 200) || `bill.${check.ext}`,
      contentType: check.contentType,
      sizeBytes: body.byteLength,
      sha256: sha256(body),
    }),
  );
}

export async function finishTask(projectId: string | null, form: FormData) {
  const user = await requireStaff('task.work');
  const back = projectId ? `/ops/projects/${projectId}` : '/ops/tasks';
  let error: string | undefined;
  try {
    await completeTask(
      getDb(),
      actorOf(user),
      str(form, 'taskId'),
      Number(str(form, 'effortMinutes')),
      str(form, 'outcome'),
    );
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e;
    error = e.message;
  }
  revalidatePath(back);
  redirect(`${back}?${error ? `error=${encodeURIComponent(error)}` : 'ok=Task+completed.'}`);
}

const optionalNumber = (form: FormData, key: string): number | undefined => {
  const v = str(form, key);
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0)
    throw new ServiceError('INVALID', `${key} must be a positive number.`);
  return n;
};

export async function createQuote(projectId: string, form: FormData) {
  const user = await requireStaff('quote.manage');
  const grade = str(form, 'grade') === 'FINAL' ? 'FINAL' : 'INDICATIVE';
  await run(projectId, 'Quote calculated.', async () => {
    const offsetPct = optionalNumber(form, 'targetOffsetPct');
    await generateQuote(getDb(), actorOf(user), projectId, {
      grade,
      tariffCategory: str(form, 'tariffCategory') || undefined,
      roofAreaM2: optionalNumber(form, 'roofAreaM2'),
      targetOffset: offsetPct != null ? offsetPct / 100 : undefined,
      packageId: str(form, 'packageId') || undefined,
    });
  });
}

export async function markQuoteSent(projectId: string, quoteId: string) {
  const user = await requireStaff('quote.manage');
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) throw new Error('PUBLIC_BASE_URL is not set');
  let url = '';
  await run(
    projectId,
    // Shown once: only the token's hash is stored. Until the WhatsApp BSP is live, share it by hand.
    () => `Quote sent. Customer link (copy now, shown once): ${url}`,
    async () => {
      url = (await sendQuote(getDb(), actorOf(user), quoteId, base)).url;
    },
  );
}

export async function markQuoteAccepted(projectId: string, quoteId: string, form: FormData) {
  const user = await requireStaff('quote.manage');
  await run(projectId, 'Acceptance recorded.', () =>
    acceptQuote(getDb(), actorOf(user), quoteId, str(form, 'note')),
  );
}
