import { createHmac } from 'node:crypto';
import { safeEqualHex } from './payments';
import type { Notifier, OutboundMessage, SendResult } from './notifier';

/**
 * Our message keys → approved WhatsApp templates. Template names and bodies must
 * match what is submitted to Meta (docs/whatsapp-templates.md). Parameters come
 * only from the outbox payload, which services fill from stored data.
 */
export interface TemplateDef {
  name: string;
  language: string;
  /** Body parameters in {{1}}, {{2}}… order. */
  params: (p: Record<string, unknown>, ctx: TemplateContext) => string[];
  /** Authentication templates also carry the code in a copy-code button. */
  otpButton?: boolean;
}

export interface TemplateContext {
  statusUrl: string | null;
}

const rupees = (paise: unknown) => `₹${Math.round(Number(paise) / 100).toLocaleString('en-IN')}`;
const first = (p: Record<string, unknown>) =>
  String(p.customerName ?? '').split(/\s+/)[0] || 'there';

export const STAGE_WORDS: Record<string, string> = {
  QUOTED: 'your proposal is ready',
  BOOKED: 'your booking is confirmed',
  SURVEYED: 'your site survey is complete',
  DESIGN_APPROVED: 'your system design is approved',
  READY_TO_INSTALL: 'everything is ready for installation',
  INSTALLED: 'your system is installed',
  COMMISSIONED: 'your system is switched on',
  HANDED_OVER: 'your handover documents are ready',
};

export const WHATSAPP_TEMPLATES: Record<string, TemplateDef> = {
  lead_received: { name: 'lead_received_v1', language: 'en', params: (p) => [first(p)] },
  stage_changed: {
    name: 'project_update_v1',
    language: 'en',
    params: (p, c) => [
      first(p),
      STAGE_WORDS[String(p.stage)] ?? 'there is an update on your project',
      c.statusUrl ?? '-',
    ],
  },
  quote_sent: {
    name: 'proposal_ready_v1',
    language: 'en',
    params: (p) => [first(p), String(p.systemKw), rupees(p.subsidyPaise), String(p.url)],
  },
  bill_resubmit: {
    name: 'bill_resubmit_v1',
    language: 'en',
    params: (p) => [first(p), String(p.reason)],
  },
  payment_link: {
    name: 'payment_link_v1',
    language: 'en',
    params: (p) => [first(p), rupees(p.amountPaise), String(p.url)],
  },
  payment_received: {
    name: 'payment_received_v1',
    language: 'en',
    params: (p, c) => [first(p), rupees(p.amountPaise), c.statusUrl ?? '-'],
  },
  loan_status: {
    name: 'loan_update_v1',
    language: 'en',
    params: (p, c) => [first(p), String(p.status).toLowerCase(), c.statusUrl ?? '-'],
  },
  otp: { name: 'login_code_v1', language: 'en', params: (p) => [String(p.code)], otpButton: true },
};

/** Build the Cloud API request body for one outbox message. */
export function buildWhatsAppBody(
  msg: OutboundMessage,
  ctx: TemplateContext,
): Record<string, unknown> {
  const to = msg.recipient.replace(/^\+/, '');
  if (msg.template === 'reply') {
    const text = String(msg.payload.text ?? '');
    if (!text.trim()) throw new Error('Empty reply');
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text.slice(0, 4096), preview_url: true },
    };
  }
  const def = WHATSAPP_TEMPLATES[msg.template];
  if (!def) throw new Error(`No WhatsApp template for ${msg.template}`);
  const params = def.params(msg.payload, ctx);
  const components: Record<string, unknown>[] = [
    { type: 'body', parameters: params.map((text) => ({ type: 'text', text })) },
  ];
  if (def.otpButton) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: params[0] }],
    });
  }
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: def.name, language: { code: def.language }, components },
  };
}

/** Plain-text rendering of what was sent, for the conversation log. */
export function describeOutbound(msg: OutboundMessage, ctx: TemplateContext): string {
  if (msg.template === 'reply') return String(msg.payload.text ?? '');
  if (msg.template === 'otp') return '[login code sent]';
  const def = WHATSAPP_TEMPLATES[msg.template];
  return def ? `[${def.name}] ${def.params(msg.payload, ctx).join(' | ')}` : `[${msg.template}]`;
}

export interface InboundWhatsApp {
  providerMessageId: string;
  /** E.164 with + */
  from: string;
  profileName: string | null;
  kind: 'text' | 'image' | 'document' | 'other';
  text: string | null;
  mediaId: string | null;
  mimeType: string | null;
}

interface MetaWebhook {
  entry?: {
    changes?: {
      value?: {
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: {
          id: string;
          from: string;
          type: string;
          text?: { body?: string };
          image?: { id?: string; mime_type?: string; caption?: string };
          document?: { id?: string; mime_type?: string; caption?: string };
          button?: { text?: string };
          interactive?: { button_reply?: { title?: string } };
        }[];
      };
    }[];
  }[];
}

export function verifyWhatsAppSignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): boolean {
  const given = (header ?? '').replace(/^sha256=/, '');
  return safeEqualHex(createHmac('sha256', appSecret).update(rawBody).digest('hex'), given);
}

/** Extract inbound customer messages; delivery/read status callbacks are ignored. */
export function parseWhatsAppWebhook(rawBody: string): InboundWhatsApp[] {
  const body = JSON.parse(rawBody) as MetaWebhook;
  const out: InboundWhatsApp[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      const names = new Map((v?.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));
      for (const m of v?.messages ?? []) {
        const media = m.image ?? m.document;
        const kind =
          m.type === 'text' || m.type === 'image' || m.type === 'document' ? m.type : 'other';
        out.push({
          providerMessageId: m.id,
          from: `+${m.from.replace(/\D/g, '')}`,
          profileName: names.get(m.from) ?? null,
          kind,
          text:
            m.text?.body ??
            media?.caption ??
            m.button?.text ??
            m.interactive?.button_reply?.title ??
            null,
          mediaId: media?.id ?? null,
          mimeType: media?.mime_type ?? null,
        });
      }
    }
  }
  return out;
}

export interface WhatsAppMedia {
  download(mediaId: string): Promise<{ body: Uint8Array; mimeType: string }>;
}

/** WhatsApp Cloud API (graph.facebook.com). */
export class MetaWhatsApp implements Notifier, WhatsAppMedia {
  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
    private readonly linkFor: (projectId: string | null) => string | null,
    private readonly graphVersion = 'v21.0',
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    const ctx = { statusUrl: this.linkFor(msg.projectId ?? null) };
    const res = await fetch(`${this.baseUrl}/${this.graphVersion}/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.accessToken}` },
      body: JSON.stringify(buildWhatsAppBody(msg, ctx)),
    });
    const json = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${json.error?.message ?? 'send failed'}`);
    return {
      providerMessageId: json.messages?.[0]?.id ?? null,
      rendered: describeOutbound(msg, ctx),
    };
  }

  async download(mediaId: string): Promise<{ body: Uint8Array; mimeType: string }> {
    const auth = { Authorization: `Bearer ${this.accessToken}` };
    const meta = await fetch(`${this.baseUrl}/${this.graphVersion}/${mediaId}`, { headers: auth });
    const info = (await meta.json().catch(() => ({}))) as { url?: string; mime_type?: string };
    if (!meta.ok || !info.url)
      throw new Error(`WhatsApp media ${mediaId}: lookup failed (${meta.status})`);
    const file = await fetch(info.url, { headers: auth });
    if (!file.ok) throw new Error(`WhatsApp media ${mediaId}: download failed (${file.status})`);
    return {
      body: new Uint8Array(await file.arrayBuffer()),
      mimeType: info.mime_type ?? 'application/octet-stream',
    };
  }
}

/** Local development: media downloads return a tiny PDF so the bill flow can be exercised. */
export class DevWhatsAppMedia implements WhatsAppMedia {
  async download(): Promise<{ body: Uint8Array; mimeType: string }> {
    return {
      body: new TextEncoder().encode('%PDF-1.4\n% dev whatsapp media\n%%EOF\n'),
      mimeType: 'application/pdf',
    };
  }
}
