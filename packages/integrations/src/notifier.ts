export interface OutboundMessage {
  id: string;
  channel: string;
  template: string;
  recipient: string;
  payload: Record<string, unknown>;
}

export interface Notifier {
  send(msg: OutboundMessage): Promise<void>;
}

/**
 * Development notifier: logs instead of sending. The WhatsApp BSP adapter
 * (approved templates, 24-hour session window) replaces it once Meta business
 * verification completes (PLAN §3, week 0).
 */
export class LogNotifier implements Notifier {
  constructor(private readonly log: (line: string) => void = console.log) {}

  async send(msg: OutboundMessage): Promise<void> {
    this.log(
      `[notify] ${msg.channel}:${msg.template} → ${maskPhone(msg.recipient)} ${JSON.stringify(msg.payload)}`,
    );
  }
}

/** Keep phone numbers out of logs: +9198XXXXXX10. */
export function maskPhone(phone: string): string {
  return phone.length > 6
    ? `${phone.slice(0, 5)}${'X'.repeat(phone.length - 7)}${phone.slice(-2)}`
    : '***';
}
