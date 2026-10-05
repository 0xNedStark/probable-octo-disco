import type { Fact, FactValues } from './facts';
import { FACTS } from './facts';
import type { MainStage } from './stages';
import { reached, type WorkstreamStates } from './workstreams';

export interface ProjectSnapshot {
  workstreams: WorkstreamStates;
  facts: FactValues;
}

export interface Requirement {
  id: string;
  label: string;
  /** Set when the requirement is a fact staff can attest to in concierge mode. */
  fact?: Fact;
  met: boolean;
}

function fact(s: ProjectSnapshot, f: Fact): Requirement {
  return { id: `fact:${f}`, label: FACTS[f].label, fact: f, met: s.facts[f] === true };
}

function ws(id: string, label: string, met: boolean): Requirement {
  return { id: `workstream:${id}`, label, met };
}

/** What must be true to enter each main stage (PLAN §4.3). */
const GATES: Record<MainStage, (s: ProjectSnapshot) => Requirement[]> = {
  LEAD: () => [],
  QUALIFIED: (s) => [ws('bill', 'Bill readings confirmed', s.workstreams.bill === 'CONFIRMED')],
  QUOTED: (s) => [fact(s, 'quote_sent')],
  BOOKED: (s) => [
    fact(s, 'contact_consent'),
    fact(s, 'quote_accepted_indicative'),
    fact(s, 'booking_advance'),
  ],
  SURVEYED: (s) => [fact(s, 'survey_completed')],
  DESIGN_APPROVED: (s) => [fact(s, 'survey_approved_by_engineer'), fact(s, 'quote_accepted_final')],
  READY_TO_INSTALL: (s) => [
    fact(s, 'funds_secured'),
    ws(
      'regulatory',
      'DISCOM feasibility approved',
      reached('regulatory', s.workstreams.regulatory, 'FEASIBILITY_APPROVED'),
    ),
    ws('procurement', 'Material delivered', s.workstreams.procurement === 'DELIVERED'),
  ],
  INSTALLED: (s) => [
    ws(
      'installation',
      'Installation submitted with evidence',
      reached('installation', s.workstreams.installation, 'SUBMITTED'),
    ),
  ],
  QA_PASSED: (s) => [
    ws('installation', 'QA approved', s.workstreams.installation === 'QA_APPROVED'),
  ],
  COMMISSIONED: (s) => [
    ws(
      'regulatory',
      'DISCOM commissioning complete',
      reached('regulatory', s.workstreams.regulatory, 'COMMISSIONED'),
    ),
  ],
  HANDED_OVER: (s) => [fact(s, 'handover_pack_complete')],
  // Subsidy release is tracked but deliberately does not block closing.
  CLOSED: (s) => [fact(s, 'ledger_reconciled'), fact(s, 'installer_payout_settled')],
};

export function requirementsFor(stage: MainStage, s: ProjectSnapshot): Requirement[] {
  return GATES[stage](s);
}
