import { newId } from '@solar/domain';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../client';
import { consents, customers, otpChallenges, outbox, solarProjects, solarQuotes } from '../schema';
import { ServiceError, type ServiceActor } from './common';
import { activeConfig } from './config';
import { lockProject, recordEvent, recordFact } from './projects';
import { getQuoteByToken } from './quotes';

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 3;
const SEND_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const hashCode = (challengeId: string, code: string) =>
  createHash('sha256').update(`${challengeId}:${code}`).digest('hex');

export const maskPhone = (phone: string) => `${phone.slice(0, 3)}••••••${phone.slice(-2)}`;

async function acceptableQuote(db: DbOrTx, token: string) {
  const found = await getQuoteByToken(db, token, { recordView: false });
  if (!found) throw new ServiceError('NOT_FOUND', 'Proposal not found.');
  const q = found.quote;
  if (q.status !== 'SENT')
    throw new ServiceError(
      'CONFLICT',
      q.status === 'ACCEPTED'
        ? 'This proposal is already accepted.'
        : 'This proposal can no longer be accepted.',
    );
  if (q.validUntil < new Date().toISOString().slice(0, 10))
    throw new ServiceError('CONFLICT', 'This proposal has expired. Ask us for an updated one.');
  return found;
}

/**
 * Send a one-time code to the customer's registered mobile so they can accept the
 * proposal themselves (click-wrap). Sent as a WhatsApp authentication template.
 */
export async function requestAcceptanceOtp(
  db: DbOrTx,
  token: string,
): Promise<{ maskedPhone: string }> {
  const found = await acceptableQuote(db, token);
  return db.transaction(async (tx) => {
    await lockProject(tx, found.quote.projectId);
    const recent = await tx
      .select({ id: otpChallenges.id })
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.purpose, 'quote_accept'),
          eq(otpChallenges.subjectId, found.quote.id),
          gt(otpChallenges.createdAt, new Date(Date.now() - SEND_WINDOW_MS)),
        ),
      );
    if (recent.length >= MAX_SENDS_PER_WINDOW) {
      throw new ServiceError(
        'CONFLICT',
        'Too many codes requested. Please wait 15 minutes and try again.',
      );
    }
    const [cust] = await tx
      .select({ phone: customers.phone })
      .from(solarProjects)
      .innerJoin(customers, eq(customers.id, solarProjects.customerId))
      .where(eq(solarProjects.id, found.quote.projectId));
    const id = newId('otp');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await tx.insert(otpChallenges).values({
      id,
      purpose: 'quote_accept',
      subjectId: found.quote.id,
      phone: cust!.phone,
      codeHash: hashCode(id, code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    });
    // Transactional message the customer asked for; not gated on marketing consent.
    await tx.insert(outbox).values({
      id: newId('outbox'),
      projectId: found.quote.projectId,
      channel: 'whatsapp',
      template: 'otp',
      recipient: cust!.phone,
      payload: { code, purpose: 'quote_accept' },
    });
    return { maskedPhone: maskPhone(cust!.phone) };
  });
}

/**
 * Verify the code and record the customer's own acceptance, with the refund
 * policy version they agreed to. Returns the project and quote for the caller
 * to continue (e.g. to the booking payment).
 */
export async function acceptWithOtp(
  db: DbOrTx,
  token: string,
  code: string,
  meta: { ip?: string; userAgent?: string },
): Promise<{ projectId: string; quoteId: string; grade: 'INDICATIVE' | 'FINAL' }> {
  const found = await acceptableQuote(db, token);
  const q = found.quote;
  type Accepted = { projectId: string; quoteId: string; grade: 'INDICATIVE' | 'FINAL' };
  const result = await db.transaction(async (tx): Promise<Accepted | { error: string }> => {
    await lockProject(tx, q.projectId);
    const [challenge] = await tx
      .select()
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.purpose, 'quote_accept'),
          eq(otpChallenges.subjectId, q.id),
          isNull(otpChallenges.consumedAt),
        ),
      )
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1)
      .for('update');
    if (!challenge || challenge.expiresAt < new Date())
      return { error: 'The code has expired. Request a new one.' };
    if (challenge.attempts >= MAX_ATTEMPTS)
      return { error: 'Too many wrong attempts. Request a new code.' };
    const expected = Buffer.from(challenge.codeHash, 'hex');
    const given = Buffer.from(hashCode(challenge.id, code.trim()), 'hex');
    if (!/^\d{6}$/.test(code.trim()) || !timingSafeEqual(expected, given)) {
      await tx
        .update(otpChallenges)
        .set({ attempts: challenge.attempts + 1 })
        .where(eq(otpChallenges.id, challenge.id));
      return { error: 'That code is not right. Please check and try again.' };
    }
    await tx
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(eq(otpChallenges.id, challenge.id));

    const [current] = await tx
      .select()
      .from(solarQuotes)
      .where(eq(solarQuotes.id, q.id))
      .for('update');
    if (current?.status !== 'SENT') return { error: 'This proposal can no longer be accepted.' };
    const [project] = await tx
      .select({ customerId: solarProjects.customerId })
      .from(solarProjects)
      .where(eq(solarProjects.id, q.projectId));
    const config = await activeConfig(tx);
    const actor: ServiceActor = { type: 'system', id: `customer:${project!.customerId}` };

    await tx
      .update(solarQuotes)
      .set({ status: 'ACCEPTED', acceptedAt: new Date() })
      .where(eq(solarQuotes.id, q.id));
    await tx.insert(consents).values({
      id: newId('consent'),
      customerId: project!.customerId,
      purpose: 'quote_terms',
      textVersion: `${config.bundle.commercial.refundPolicyVersion}|quote:${q.id}`,
      channel: 'web-otp',
    });
    await recordEvent(tx, {
      projectId: q.projectId,
      type: 'quote_accepted',
      actor,
      to: `v${q.version}`,
      reason: 'Accepted by customer with OTP',
      payload: {
        quoteId: q.id,
        otpChallengeId: challenge.id,
        refundPolicyVersion: config.bundle.commercial.refundPolicyVersion,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
      },
    });
    const fact = q.grade === 'INDICATIVE' ? 'quote_accepted_indicative' : 'quote_accepted_final';
    await recordFact(
      tx,
      actor,
      q.projectId,
      fact,
      true,
      `Quote v${q.version} accepted by customer (OTP)`,
    );
    return { projectId: q.projectId, quoteId: q.id, grade: q.grade };
  });
  if ('error' in result) throw new ServiceError('INVALID', result.error);
  return result;
}
