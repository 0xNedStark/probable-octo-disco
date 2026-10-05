const IST = 'Asia/Kolkata';

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(d));
}

export function formatRupees(paise: number | null | undefined): string {
  if (paise == null) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
}

export function relativeDue(due: Date, now = new Date()): { text: string; overdue: boolean } {
  const mins = Math.round((due.getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(mins);
  const span =
    abs < 60
      ? `${abs}m`
      : abs < 48 * 60
        ? `${Math.round(abs / 60)}h`
        : `${Math.round(abs / 1440)}d`;
  return mins < 0
    ? { text: `${span} overdue`, overdue: true }
    : { text: `due in ${span}`, overdue: false };
}

export const humanize = (s: string) => s.toLowerCase().replace(/_/g, ' ');
