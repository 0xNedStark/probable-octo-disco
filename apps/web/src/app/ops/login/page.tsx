import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { login } from './actions';

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getCurrentUser()) redirect('/ops');
  const { error } = await searchParams;
  return (
    <main className="container narrow">
      <form action={login} className="card stack">
        <h1>Ops sign in</h1>
        {error && (
          <p className="alert error" role="alert">
            Email or password is incorrect, or the account is locked.
          </p>
        )}
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
