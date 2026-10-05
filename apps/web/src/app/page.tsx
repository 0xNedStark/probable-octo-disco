import { LeadForm } from './lead-form';

export default function Home() {
  return (
    <main className="container narrow">
      <section className="hero">
        <h1>Rooftop solar, handled end to end.</h1>
        <p>
          Upload your electricity bill. We take care of the rest — sizing, PM Surya Ghar subsidy
          paperwork, financing, installation and DVVNL net metering.
        </p>
        <p lang="hi">अपना बिजली बिल भेजें। बाकी सब हम संभालेंगे।</p>
      </section>
      <section className="card">
        <h2>Free solar assessment</h2>
        <p className="muted small">
          Currently serving homes in the DVVNL area of Uttar Pradesh (Agra and nearby).
        </p>
        <LeadForm />
      </section>
    </main>
  );
}
