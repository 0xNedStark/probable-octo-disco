import { listTasks } from '@solar/db';
import Link from 'next/link';
import { requireStaff } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { relativeDue } from '@/lib/format';
import { Flash } from '../../flash';
import { finishTask } from '../projects/[id]/actions';

export default async function Tasks({
  searchParams,
}: {
  searchParams: Promise<{ mine?: string; error?: string; ok?: string }>;
}) {
  const user = await requireStaff();
  const { mine, error, ok } = await searchParams;
  const rows = await listTasks(getDb(), { forUserId: mine ? user.id : undefined });

  return (
    <div className="stack">
      <Flash error={error} ok={ok} />
      <section className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>Open tasks ({rows.length})</h2>
          <div className="row small">
            <Link href="/ops/tasks">All</Link>
            <Link href="/ops/tasks?mine=1">Mine + unassigned</Link>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Due</th>
                <th>Task</th>
                <th>Project</th>
                <th>Complete</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ task: t, projectCode, customerName }) => {
                const due = relativeDue(t.dueAt);
                return (
                  <tr key={t.id}>
                    <td>
                      <span className={`badge ${due.overdue ? 'bad' : ''}`}>{due.text}</span>
                    </td>
                    <td>
                      {t.title}
                      <div className="muted small">{t.role}</div>
                    </td>
                    <td>
                      {t.projectId ? (
                        <Link href={`/ops/projects/${t.projectId}`}>{projectCode}</Link>
                      ) : (
                        '—'
                      )}
                      <div className="muted small">{customerName}</div>
                    </td>
                    <td>
                      <form action={finishTask.bind(null, null)} className="row small">
                        <input type="hidden" name="taskId" value={t.id} />
                        <input
                          name="effortMinutes"
                          inputMode="numeric"
                          placeholder="Min"
                          required
                          style={{ width: 70 }}
                        />
                        <input name="outcome" placeholder="Outcome" style={{ width: 160 }} />
                        <button type="submit" className="secondary">
                          Done
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    Inbox zero.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
