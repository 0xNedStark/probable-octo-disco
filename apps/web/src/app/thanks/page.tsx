import Link from 'next/link';

export default async function Thanks({
  searchParams,
}: {
  searchParams: Promise<{ bill?: string }>;
}) {
  const { bill } = await searchParams;
  return (
    <main className="container narrow">
      <div className="card stack">
        <h1>Thank you — we’ve got it.</h1>
        <p>Our team will call you shortly, usually within a few minutes during working hours.</p>
        {bill === '0' && (
          <p className="muted">
            Keep a recent electricity bill handy — we’ll need it to size your system and estimate
            your PM Surya Ghar subsidy.
          </p>
        )}
        <p lang="hi">धन्यवाद! हमारी टीम जल्द ही आपसे संपर्क करेगी।</p>
        <p>
          <Link href="/">Back to home</Link>
        </p>
      </div>
    </main>
  );
}
