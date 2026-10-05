import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="container narrow">
      <div className="card">
        <h1>Not found</h1>
        <Link href="/ops">Back to projects</Link>
      </div>
    </main>
  );
}
