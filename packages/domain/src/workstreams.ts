/**
 * Workstreams run in parallel under a project's stage (docs/PLAN.md §4.2).
 * Each is a small state machine defined as data so the ops console can render
 * the allowed moves and the transition matrix test can cover every edge.
 */
interface MachineDef<S extends string> {
  readonly states: readonly S[];
  readonly initial: S;
  readonly edges: Readonly<Record<S, readonly S[]>>;
}

function machine<const S extends string>(def: MachineDef<S>): MachineDef<S> {
  return def;
}

export const WORKSTREAMS = {
  bill: machine({
    states: [
      'NOT_RECEIVED',
      'RECEIVED',
      'EXTRACTED',
      'NEEDS_MANUAL',
      'NEEDS_RESUBMIT',
      'CONFIRMED',
    ],
    initial: 'NOT_RECEIVED',
    edges: {
      NOT_RECEIVED: ['RECEIVED'],
      RECEIVED: ['EXTRACTED', 'NEEDS_MANUAL', 'NEEDS_RESUBMIT'],
      EXTRACTED: ['CONFIRMED', 'NEEDS_MANUAL', 'NEEDS_RESUBMIT'],
      NEEDS_MANUAL: ['CONFIRMED', 'NEEDS_RESUBMIT'],
      NEEDS_RESUBMIT: ['RECEIVED'],
      CONFIRMED: ['RECEIVED'], // a newer bill replaces the confirmed one
    },
  }),
  finance: machine({
    states: [
      'UNDECIDED',
      'NOT_REQUIRED',
      'DOCS_PENDING',
      'SUBMITTED',
      'SANCTIONED',
      'REJECTED',
      'DISBURSED',
    ],
    initial: 'UNDECIDED',
    edges: {
      UNDECIDED: ['NOT_REQUIRED', 'DOCS_PENDING'],
      NOT_REQUIRED: ['DOCS_PENDING'],
      DOCS_PENDING: ['SUBMITTED', 'NOT_REQUIRED'],
      SUBMITTED: ['SANCTIONED', 'REJECTED', 'DOCS_PENDING'],
      REJECTED: ['DOCS_PENDING', 'NOT_REQUIRED'], // alternate lender, or switch to cash
      SANCTIONED: ['DISBURSED'],
      DISBURSED: [],
    },
  }),
  regulatory: machine({
    // DVVNL / PM Surya Ghar national-portal flow (PLAN §3A). Moves to a config-driven
    // per-DISCOM checklist once a second DISCOM is added.
    states: [
      'NOT_STARTED',
      'PORTAL_REGISTERED',
      'FEASIBILITY_SUBMITTED',
      'FEASIBILITY_REJECTED',
      'FEASIBILITY_APPROVED',
      'INSTALLATION_DETAILS_UPLOADED',
      'NET_METER_INSTALLED',
      'INSPECTED',
      'COMMISSIONED',
      'SUBSIDY_CLAIMED',
      'SUBSIDY_RELEASED',
    ],
    initial: 'NOT_STARTED',
    edges: {
      NOT_STARTED: ['PORTAL_REGISTERED'],
      PORTAL_REGISTERED: ['FEASIBILITY_SUBMITTED'],
      FEASIBILITY_SUBMITTED: ['FEASIBILITY_APPROVED', 'FEASIBILITY_REJECTED'],
      FEASIBILITY_REJECTED: ['FEASIBILITY_SUBMITTED'],
      FEASIBILITY_APPROVED: ['INSTALLATION_DETAILS_UPLOADED'],
      INSTALLATION_DETAILS_UPLOADED: ['NET_METER_INSTALLED'],
      NET_METER_INSTALLED: ['INSPECTED'],
      INSPECTED: ['COMMISSIONED'],
      COMMISSIONED: ['SUBSIDY_CLAIMED'],
      SUBSIDY_CLAIMED: ['SUBSIDY_RELEASED'],
      SUBSIDY_RELEASED: [],
    },
  }),
  procurement: machine({
    states: ['NOT_STARTED', 'DRAFT', 'APPROVED', 'ORDERED', 'PARTIALLY_DELIVERED', 'DELIVERED'],
    initial: 'NOT_STARTED',
    edges: {
      NOT_STARTED: ['DRAFT'],
      DRAFT: ['APPROVED', 'NOT_STARTED'],
      APPROVED: ['ORDERED', 'DRAFT'],
      ORDERED: ['PARTIALLY_DELIVERED', 'DELIVERED'],
      PARTIALLY_DELIVERED: ['DELIVERED'],
      DELIVERED: [],
    },
  }),
  installation: machine({
    states: [
      'NOT_ASSIGNED',
      'ASSIGNED',
      'ACCEPTED',
      'SCHEDULED',
      'IN_PROGRESS',
      'SUBMITTED',
      'QA_REJECTED',
      'QA_APPROVED',
    ],
    initial: 'NOT_ASSIGNED',
    edges: {
      NOT_ASSIGNED: ['ASSIGNED'],
      ASSIGNED: ['ACCEPTED', 'NOT_ASSIGNED'], // installer declined
      ACCEPTED: ['SCHEDULED', 'NOT_ASSIGNED'],
      SCHEDULED: ['IN_PROGRESS', 'ACCEPTED'], // reschedule
      IN_PROGRESS: ['SUBMITTED'],
      SUBMITTED: ['QA_APPROVED', 'QA_REJECTED'],
      QA_REJECTED: ['IN_PROGRESS'],
      QA_APPROVED: [],
    },
  }),
} as const;

export type Workstream = keyof typeof WORKSTREAMS;
export type WorkstreamState<W extends Workstream> = (typeof WORKSTREAMS)[W]['states'][number];
export type WorkstreamStates = { [W in Workstream]: WorkstreamState<W> };

export const WORKSTREAM_NAMES = Object.keys(WORKSTREAMS) as Workstream[];

export function isWorkstream(name: string): name is Workstream {
  return name in WORKSTREAMS;
}

export function initialWorkstreams(): WorkstreamStates {
  return {
    bill: WORKSTREAMS.bill.initial,
    finance: WORKSTREAMS.finance.initial,
    regulatory: WORKSTREAMS.regulatory.initial,
    procurement: WORKSTREAMS.procurement.initial,
    installation: WORKSTREAMS.installation.initial,
  };
}

export function workstreamNext<W extends Workstream>(
  w: W,
  from: WorkstreamState<W>,
): readonly WorkstreamState<W>[] {
  const edges = WORKSTREAMS[w].edges as Record<string, readonly WorkstreamState<W>[]>;
  return edges[from] ?? [];
}

export function isWorkstreamState<W extends Workstream>(
  w: W,
  state: string,
): state is WorkstreamState<W> {
  return (WORKSTREAMS[w].states as readonly string[]).includes(state);
}

/** True when `state` is `target` or a later state in the workstream's declared order. */
export function reached<W extends Workstream>(
  w: W,
  state: WorkstreamState<W>,
  target: WorkstreamState<W>,
): boolean {
  const states = WORKSTREAMS[w].states as readonly string[];
  return states.indexOf(state) >= states.indexOf(target);
}
