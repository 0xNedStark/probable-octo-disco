export interface OutboundMessage {
  id: string;
  projectId?: string | null;
  channel: string;
  template: string;
  recipient: string;
  payload: Record<string, unknown>;
}

export interface SendResult {
  providerMessageId: string | null;
  /** Human-readable text of what was sent, for the conversation log. */
  rendered: string;
}

export interface Notifier {
  send(msg: OutboundMessage): Promise<SendResult | void>;
}

/**
 * Development notifier: logs instead of sending. Replaced by MetaWhatsApp when
 * WHATSAPP_PROVIDER=meta (after Meta business verification, PLAN §3).
 */
export class LogNotifier implements Notifier {
  constructor(private readonly log: (line: string) => void = console.log) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    const safe = msg.template === 'otp' ? { ...msg.payload, code: '******' } : msg.payload;
    this.log(
      `[notify] ${msg.channel}:${msg.template} → ${maskPhone(msg.recipient)} ${JSON.stringify(safe)}`,
    );
    const rendered =
      msg.template === 'reply' ? String(msg.payload.text ?? '') : `[${msg.template}]`;
    return { providerMessageId: null, rendered };
  }
}

/** Keep phone numbers out of logs: +9198XXXXXX10. */
export function maskPhone(phone: string): string {
  return phone.length > 6
    ? `${phone.slice(0, 5)}${'X'.repeat(phone.length - 7)}${phone.slice(-2)}`
    : '***';
}
