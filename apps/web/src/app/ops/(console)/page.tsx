import { dashboardSummary, listProjects } from '@solar/db';
import { isStage, MAIN_STAGES, SIDE_STAGES, STAGE_LABELS } from '@solar/domain';
import Link from 'next/link';
import { requireStaff } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatDateTime, humanize } from '@/lib/format';
import { Flash } from '../flash';
import { StageBadge } from '../stage-badge';

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string; q?: string; error?: string }>;
}) {
  await requireStaff();
  const { stage, q, error } = await searchParams;
  const db = getDb();
  const [summary, projects] = await Promise.all([
    dashboardSummary(db),
    listProjects(db, { stage: stage && isStage(stage) ? stage : undefined, q }),
  ]);

  return (
    <div className="stack">
      <Flash error={error} />
      <section className="grid grid-3">
        <div className="card">
          <div className="muted small">New leads today</div>
          <div className="stat">{summary.leadsToday}</div>
        </div>
        <div className="card">
          <div className="muted small">Overdue tasks</div>
          <div className="stat" style={{ color: summary.overdueTasks ? 'var(--bad)' : undefined }}>
            {summary.overdueTasks}
          </div>
          <Link href="/ops/tasks" className="small">
            Open task inbox
          </Link>
        </div>
        <div className="card">
          <div className="muted small">On hold</div>
          <div className="stat">{summary.onHold.length}</div>
          {summary.onHold.slice(0, 3).map((p) => (
            <div key={p.id} className="small">
              <Link href={`/ops/projects/${p.id}`}>{p.code}</Link> {p.customerName}
            </div>
          ))}
        </div>
      </section>

      <section className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>Projects</h2>
          <form className="row" action="/ops">
            <input
              name="q"
              placeholder="Name, phone or SOL code"
              defaultValue={q}
              style={{ width: 220 }}
            />
            <select name="stage" defaultValue={stage ?? ''} style={{ width: 180 }}>
              <option value="">All stages</option>
              {[...MAIN_STAGES, ...SIDE_STAGES].map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s]} ({summary.byStage[s] ?? 0})
                </option>
              ))}
            </select>
            <button type="submit" className="secondary">
              Filter
            </button>
          </form>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Customer</th>
                <th>Stage</th>
                <th>Bill</th>
                <th>Tasks</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/ops/projects/${p.id}`}>{p.code}</Link>
                  </td>
                  <td>
                    {p.customerName}
                    <div className="muted small">
                      {p.city} · {p.phone}
                    </div>
                  </td>
                  <td>
                    <StageBadge stage={p.stage} />
                  </td>
                  <td className="small">{humanize(p.billState)}</td>
                  <td>
                    {p.openTasks}
                    {p.overdueTasks > 0 && (
                      <span className="badge bad"> {p.overdueTasks} overdue</span>
                    )}
                  </td>
                  <td className="small">{formatDateTime(p.updatedAt)}</td>
                </tr>
              ))}
              {projects.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No projects match.
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
