import Link from 'next/link';
import type { ReactNode } from 'react';
import { requireStaff } from '@/lib/auth';
import { logout } from '../login/actions';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const user = await requireStaff();
  return (
    <>
      <header className="topbar">
        <nav>
          <Link href="/ops">Projects</Link>
          <Link href="/ops/tasks">Tasks</Link>
          <Link href="/ops/config">Config</Link>
        </nav>
        <form action={logout} className="row">
          <span className="muted small">
            {user.name} · {user.role}
          </span>
          <button type="submit" className="secondary">
            Sign out
          </button>
        </form>
      </header>
      <main className="container">{children}</main>
    </>
  );
}
