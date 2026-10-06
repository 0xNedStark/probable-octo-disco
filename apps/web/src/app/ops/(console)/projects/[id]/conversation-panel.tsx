import type { MessageRow } from '@solar/db';
import { SESSION_WINDOW_MS } from '@solar/db';
import { formatDateTime } from '@/lib/format';
import { replyOnWhatsApp } from './actions';

export function ConversationPanel({
  projectId,
  messages,
  canSend,
}: {
  projectId: string;
  messages: MessageRow[];
  canSend: boolean;
}) {
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
  const windowOpen = lastIn ? Date.now() - lastIn.createdAt.getTime() < SESSION_WINDOW_MS : false;
  return (
    <section className="card stack">
      <h2>WhatsApp</h2>
      {messages.length === 0 && <p className="muted small">No messages yet.</p>}
      <ul className="chat small">
        {messages.map((m) => (
          <li key={m.id} style={{ textAlign: m.direction === 'out' ? 'right' : 'left' }}>
            <div className="muted">
              {m.direction === 'in' ? 'Customer' : (m.author ?? 'us')} ·{' '}
              {formatDateTime(m.createdAt)}
              {m.kind !== 'text' ? ` · ${m.kind}` : ''}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>
              {m.body ?? (m.mediaId ? '[attachment]' : '')}
            </div>
          </li>
        ))}
      </ul>
      {canSend &&
        (windowOpen ? (
          <form action={replyOnWhatsApp.bind(null, projectId)} className="stack small">
            <textarea name="text" rows={2} placeholder="Reply to the customer…" required />
            <button type="submit" className="secondary">
              Send on WhatsApp
            </button>
          </form>
        ) : (
          <p className="muted small">
            The 24-hour reply window is closed. Free-form replies open again when the customer
            messages; call them or use a template message.
          </p>
        ))}
    </section>
  );
}
