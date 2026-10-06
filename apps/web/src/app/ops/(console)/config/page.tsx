import { activeConfig, configHistory } from '@solar/db';
import { CONFIG_KINDS } from '@solar/calc';
import { can } from '@solar/domain';
import { requireStaff } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatDateTime } from '@/lib/format';
import { Flash } from '../../flash';
import { publish } from './actions';

const KIND_LABELS = {
  pricebook: 'Price book (packages, line items, GST)',
  tariff: 'Tariff (DISCOM slabs, fixed charges, net metering)',
  subsidy: 'Subsidy rules',
  lenders: 'Lender products',
  site: 'Site assumptions (yield, profiles, sizing limits)',
  commercial: 'Commercial terms (booking token, refund policy)',
} as const;

export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const user = await requireStaff();
  const { error, ok } = await searchParams;
  const db = getDb();
  const config = await activeConfig(db);
  const histories = await Promise.all(CONFIG_KINDS.map((k) => configHistory(db, k)));
  const canPublish = can(user.role, 'config.manage');

  return (
    <div className="stack">
      <Flash error={error} ok={ok} />
      <section className="card stack">
        <h2>Calculation configuration</h2>
        <p className="muted small">
          Every quote records the exact versions below, so it can be reproduced later. Publishing
          creates a new version; existing quotes are unaffected. Active config hash:{' '}
          <code>{config.hash.slice(0, 16)}</code>
        </p>
      </section>
      {CONFIG_KINDS.map((kind, i) => {
        const row = config.rows[kind];
        const body = config.bundle[kind] as {
          placeholder?: boolean;
          products?: { placeholder: boolean }[];
        };
        const placeholder = body.placeholder === true || body.products?.some((p) => p.placeholder);
        return (
          <section key={kind} className="card stack">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2>{KIND_LABELS[kind]}</h2>
              <div className="row">
                {placeholder && <span className="badge warn">placeholder values</span>}
                <span className="badge">{config.labels[kind]}</span>
              </div>
            </div>
            <p className="small">
              {row.note} <span className="muted">· {formatDateTime(row.createdAt)}</span>
            </p>
            <details>
              <summary className="small">History</summary>
              <ul className="small">
                {histories[i]!.map((h) => (
                  <li key={h.id}>
                    v{h.version} · {formatDateTime(h.createdAt)} · {h.note}
                  </li>
                ))}
              </ul>
            </details>
            <details>
              <summary className="small">
                {canPublish ? 'View / publish new version' : 'View'}
              </summary>
              <form action={publish} className="stack" style={{ marginTop: 8 }}>
                <input type="hidden" name="kind" value={kind} />
                <textarea
                  name="body"
                  rows={18}
                  defaultValue={JSON.stringify(config.bundle[kind], null, 2)}
                  readOnly={!canPublish}
                  style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
                  aria-label={`${kind} JSON`}
                />
                {canPublish && (
                  <div className="row">
                    <input
                      name="note"
                      placeholder="What changed and why (required)"
                      required
                      style={{ flex: 1 }}
                    />
                    <button type="submit">
                      Publish {kind} v{Number(config.labels[kind].split('@')[1]) + 1}
                    </button>
                  </div>
                )}
              </form>
            </details>
          </section>
        );
      })}
    </div>
  );
}
