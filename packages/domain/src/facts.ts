import type { Role } from './roles';

/**
 * Facts are boolean conditions that gates depend on but that are produced by
 * modules not built yet (quotes, payments, survey, handover...). Until those
 * modules exist, authorised staff record them manually with a note — the
 * concierge mode of PLAN §2 item 1. Later the owning module records them with
 * source = 'system'. Either way each recording is an audited event.
 */
export const FACTS = {
  contact_consent: {
    label: 'Customer consented to be contacted',
    attestableBy: [],
  },
  quote_sent: {
    label: 'Indicative quote sent to customer',
    attestableBy: ['admin', 'ops', 'sales'],
  },
  quote_accepted_indicative: {
    label: 'Customer accepted indicative quote',
    attestableBy: ['admin', 'ops', 'sales'],
  },
  booking_advance: {
    label: 'Booking advance received (or waived with reason)',
    attestableBy: ['admin', 'finance'],
  },
  survey_completed: {
    label: 'Site survey completed',
    attestableBy: ['admin', 'ops'],
  },
  survey_approved_by_engineer: {
    label: 'Survey and design approved by engineer',
    attestableBy: ['admin', 'engineer'],
  },
  quote_accepted_final: {
    label: 'Customer accepted final quote',
    attestableBy: ['admin', 'ops', 'sales'],
  },
  funds_secured: {
    label: 'Funds secured (cash milestone received or loan sanctioned)',
    attestableBy: ['admin', 'finance'],
  },
  handover_pack_complete: {
    label: 'Handover pack delivered to customer',
    attestableBy: ['admin', 'ops'],
  },
  ledger_reconciled: {
    label: 'Project payments reconciled',
    attestableBy: ['admin', 'finance'],
  },
  installer_payout_settled: {
    label: 'Installer payout settled',
    attestableBy: ['admin', 'finance'],
  },
} as const satisfies Record<string, { label: string; attestableBy: readonly Role[] }>;

export type Fact = keyof typeof FACTS;
export type FactValues = Partial<Record<Fact, boolean>>;

export function isFact(name: string): name is Fact {
  return name in FACTS;
}

export function canAttest(role: Role, fact: Fact): boolean {
  return (FACTS[fact].attestableBy as readonly Role[]).includes(role);
}
