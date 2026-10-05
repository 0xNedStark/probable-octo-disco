import { CONSENT_TEXT_VERSION } from '@/lib/consent';

export default function Privacy() {
  return (
    <main className="container narrow">
      <article className="card stack">
        <h1>Privacy notice</h1>
        <p className="muted small">Version {CONSENT_TEXT_VERSION}. Draft pending legal review.</p>
        <h2>What we collect</h2>
        <p>
          Your name, mobile number, location, and the electricity bill you upload (which includes
          your DVVNL account number, consumption and tariff).
        </p>
        <h2>Why</h2>
        <p>
          To assess whether rooftop solar suits your home, prepare a proposal, and contact you about
          it. If you opt in, we send updates on WhatsApp.
        </p>
        <h2>Where it is stored</h2>
        <p>
          On servers in India. Access is limited to our team members who need it, and is logged.
        </p>
        <h2>Your choices</h2>
        <p>
          You can withdraw consent or ask us to delete your data at any time by contacting our
          grievance officer (contact details to be published before launch).
        </p>
      </article>
    </main>
  );
}
