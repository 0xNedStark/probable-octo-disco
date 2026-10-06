import {
  attachBill,
  conversation,
  createTask,
  customerFacts,
  eq,
  getMessage,
  logAiAction,
  queueReply,
  recordBillExtraction,
  recordEvent,
  schema,
  type DbOrTx,
  type OutboxMessage,
} from '@solar/db';
import { newId } from '@solar/domain';
import {
  checkBillFile,
  guardReply,
  sha256,
  type ClaudeBillExtractor,
  type ClaudeSalesAgent,
  type Storage,
  type WhatsAppMedia,
} from '@solar/integrations';
import type { JobHandlers } from './dispatch';

export interface JobDeps {
  db: DbOrTx;
  storage: Storage;
  /** null when AI extraction is switched off; bills then wait for manual entry. */
  billExtractor: Pick<ClaudeBillExtractor, 'extract'> | null;
  confidenceThreshold: number;
  /** null when the Sales Agent is off; inbound messages go to the human inbox. */
  salesAgent?: Pick<ClaudeSalesAgent, 'reply'> | null;
  media?: WhatsAppMedia | null;
  links?: { statusUrl: (projectId: string) => string | null; privacyUrl: string | null };
  log?: (line: string) => void;
}

type MediaType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
const AGENT = { type: 'agent', id: 'whatsapp-intake' } as const;

export const BILL_RECEIVED_REPLY =
  'धन्यवाद! हमें आपका बिजली बिल मिल गया है — हम इसे देखकर जल्द ही आपका प्रस्ताव भेजेंगे।\nThanks — we have received your electricity bill and will send your proposal soon.';
export const BAD_FILE_REPLY =
  'माफ़ कीजिए, यह फ़ाइल नहीं खुल रही। कृपया बिल की साफ़ फ़ोटो या PDF भेजें।\nSorry, we could not open that file. Please send a clear photo or PDF of your bill.';

export function jobHandlers(deps: JobDeps): JobHandlers {
  const log = deps.log ?? console.log;
  return {
    'bill.extract': async (msg: OutboxMessage) => {
      const billId = String(msg.payload.billId ?? '');
      if (!deps.billExtractor) {
        log(`[bill.extract] AI extraction off; ${billId} left for manual entry`);
        return;
      }
      const [bill] = await deps.db
        .select()
        .from(schema.electricityBills)
        .where(eq(schema.electricityBills.id, billId));
      if (!bill) throw new Error(`Bill ${billId} not found`);
      const body = await deps.storage.get(bill.storageKey);
      const r = await deps.billExtractor.extract(body, bill.contentType as MediaType);
      const aiActionId = await logAiAction(deps.db, {
        projectId: bill.projectId,
        agent: 'bill-agent',
        promptVersion: r.promptVersion,
        model: r.model,
        inputRef: { billId, sha256: bill.sha256 },
        output: r.extraction ? { ...r.extraction } : null,
        outcome: r.outcome,
        error: r.error,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        latencyMs: r.latencyMs,
      });
      const res = await recordBillExtraction(deps.db, bill.projectId, billId, r.extraction, {
        threshold: deps.confidenceThreshold,
        aiActionId,
        failure: r.outcome === 'ok' ? undefined : `Automatic reading failed (${r.outcome}).`,
      });
      log(
        `[bill.extract] ${billId}: ${r.outcome} → ${res.state}${res.problems.length ? ` (${res.problems.join(' ')})` : ''}`,
      );
    },

    /** A photo/PDF sent on WhatsApp becomes a bill on the project. */
    'whatsapp.media': async (msg: OutboxMessage) => {
      const m = await getMessage(deps.db, String(msg.payload.messageId ?? ''));
      if (!m?.projectId || !m.mediaId) throw new Error('media message not found');
      if (!deps.media) throw new Error('WhatsApp media download is not configured');
      const file = await deps.media.download(m.mediaId);
      const check = checkBillFile(file.body);
      if (!check.ok) {
        await queueReply(deps.db, { kind: 'agent', id: AGENT.id }, m.projectId, BAD_FILE_REPLY);
        return;
      }
      const id = newId('bill');
      const now = new Date();
      const storageKey = `bills/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.${check.ext}`;
      await deps.storage.put(storageKey, file.body, check.contentType);
      await attachBill(
        deps.db,
        AGENT,
        m.projectId,
        {
          id,
          storageKey,
          originalFilename: `whatsapp-${m.id}.${check.ext}`,
          contentType: check.contentType,
          sizeBytes: file.body.byteLength,
          sha256: sha256(file.body),
        },
        'whatsapp',
      );
      await queueReply(deps.db, { kind: 'agent', id: AGENT.id }, m.projectId, BILL_RECEIVED_REPLY);
      log(`[whatsapp.media] ${m.id} → bill ${id}`);
    },

    /** Draft a reply with the Sales Agent; send it only if it passes the deterministic guard. */
    'sales_agent.reply': async (msg: OutboxMessage) => {
      const m = await getMessage(deps.db, String(msg.payload.messageId ?? ''));
      if (!m?.projectId) throw new Error('message not found');
      const history = await conversation(deps.db, m.phone, 12);
      // Several quick messages: answer only the latest one.
      const latestIn = [...history].reverse().find((h) => h.direction === 'in');
      if (latestIn && latestIn.id !== m.id) return;

      const handOff = async (title: string, payload: Record<string, unknown> = {}) => {
        await createTask(deps.db, 'whatsapp_reply', m.projectId, { title });
        await recordEvent(deps.db, {
          projectId: m.projectId!,
          type: 'whatsapp_handoff',
          actor: { type: 'agent', id: 'sales-agent' },
          reason: title,
          payload,
        });
      };
      if (!deps.salesAgent) {
        await handOff(`Reply on WhatsApp: “${(m.body ?? '').slice(0, 80)}”`);
        return;
      }
      const facts = await customerFacts(deps.db, m.projectId, {
        statusUrl: deps.links?.statusUrl(m.projectId) ?? null,
        privacyUrl: deps.links?.privacyUrl ?? null,
      });
      const turns = history
        .filter((h) => h.body)
        .map((h) => ({ direction: h.direction, text: h.body! }));
      const r = await deps.salesAgent.reply(facts, turns);
      const guard = r.reply ? guardReply(r.reply, facts, m.body ?? '') : null;
      await logAiAction(deps.db, {
        projectId: m.projectId,
        agent: 'sales-agent',
        promptVersion: r.promptVersion,
        model: r.model,
        inputRef: { messageId: m.id },
        output: r.reply ? { ...r.reply, guard } : null,
        outcome: r.outcome,
        error: r.error,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        latencyMs: r.latencyMs,
      });
      if (!r.reply || !guard) {
        await handOff(`Agent could not reply (${r.outcome}): “${(m.body ?? '').slice(0, 60)}”`);
        return;
      }
      if (!guard.ok) {
        await handOff(
          `Agent draft blocked (${guard.reasons.join('; ')}): “${(m.body ?? '').slice(0, 60)}”`,
          { draft: r.reply.reply },
        );
        return;
      }
      await queueReply(deps.db, { kind: 'agent', id: 'sales-agent' }, m.projectId, r.reply.reply);
      if (guard.escalate) {
        await handOff(
          `Follow up (${r.reply.intent}): ${r.reply.escalation_reason ?? (m.body ?? '').slice(0, 60)}`,
        );
      }
      log(`[sales_agent.reply] ${m.id}: ${r.reply.intent}${guard.escalate ? ' (escalated)' : ''}`);
    },
  };
}
