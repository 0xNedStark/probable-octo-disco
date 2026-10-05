import { describe, expect, it } from 'vitest';
import { FACTS, type Fact } from './facts';
import { MAIN_STAGES, SIDE_STAGES, type MainStage, type Stage, nextStages } from './stages';
import {
  planStageTransition,
  planWorkstreamTransition,
  stageOptions,
  type StageSnapshot,
} from './transitions';
import {
  WORKSTREAMS,
  WORKSTREAM_NAMES,
  initialWorkstreams,
  type WorkstreamStates,
} from './workstreams';

const ALL_STAGES: Stage[] = [...MAIN_STAGES, ...SIDE_STAGES];

function snapshot(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
  return {
    stage: 'LEAD',
    heldFromStage: null,
    workstreams: initialWorkstreams(),
    facts: {},
    ...overrides,
  };
}

/** A snapshot in which every gate is satisfied. */
function everythingDone(stage: Stage, heldFromStage: MainStage | null = null): StageSnapshot {
  const facts = Object.fromEntries(Object.keys(FACTS).map((f) => [f, true])) as Record<
    Fact,
    boolean
  >;
  const workstreams: WorkstreamStates = {
    bill: 'CONFIRMED',
    finance: 'DISBURSED',
    regulatory: 'SUBSIDY_RELEASED',
    procurement: 'DELIVERED',
    installation: 'QA_APPROVED',
  };
  return { stage, heldFromStage, workstreams, facts };
}

describe('stage transition matrix', () => {
  // With every gate satisfied and a reason given, a move succeeds exactly when the
  // edge exists in the stage graph; every other pair is rejected.
  for (const from of ALL_STAGES) {
    const heldFrom: MainStage | null = from === 'ON_HOLD' ? 'QUOTED' : null;
    for (const to of ALL_STAGES) {
      const legal = nextStages(from, heldFrom).includes(to);
      it(`${from} → ${to} is ${legal ? 'allowed' : 'rejected'}`, () => {
        const result = planStageTransition(everythingDone(from, heldFrom), to, 'test reason');
        expect(result.ok).toBe(legal);
      });
    }
  }
});

describe('stage graph', () => {
  it('moves forward one main stage at a time', () => {
    MAIN_STAGES.slice(0, -1).forEach((stage, i) => {
      expect(nextStages(stage, null)).toContain(MAIN_STAGES[i + 1]);
      const skip = MAIN_STAGES[i + 2];
      if (skip) expect(nextStages(stage, null)).not.toContain(skip);
    });
  });

  it('terminal stages have no exits', () => {
    for (const s of ['CLOSED', 'CANCELLED', 'LOST'] as const)
      expect(nextStages(s, null)).toEqual([]);
  });

  it('leads before booking are LOST, booked projects are CANCELLED', () => {
    expect(nextStages('QUOTED', null)).toContain('LOST');
    expect(nextStages('QUOTED', null)).not.toContain('CANCELLED');
    expect(nextStages('BOOKED', null)).toContain('CANCELLED');
    expect(nextStages('BOOKED', null)).not.toContain('LOST');
  });

  it('cannot cancel once installation has happened', () => {
    for (const s of ['INSTALLED', 'QA_PASSED', 'COMMISSIONED', 'HANDED_OVER'] as const) {
      expect(nextStages(s, null)).not.toContain('CANCELLED');
      expect(nextStages(s, null)).toContain('ON_HOLD');
    }
  });

  it('ON_HOLD resumes only to the stage it was held from', () => {
    expect(nextStages('ON_HOLD', 'SURVEYED')).toEqual(['SURVEYED', 'CANCELLED']);
    expect(nextStages('ON_HOLD', null)).toEqual([]);
  });
});

describe('gates', () => {
  it('blocks QUALIFIED until the bill is confirmed', () => {
    const blocked = planStageTransition(snapshot(), 'QUALIFIED', undefined);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.code).toBe('GATE_FAILED');
      if (blocked.error.code === 'GATE_FAILED') {
        expect(blocked.error.unmet.map((r) => r.id)).toEqual(['workstream:bill']);
      }
    }
    const ok = planStageTransition(
      snapshot({ workstreams: { ...initialWorkstreams(), bill: 'CONFIRMED' } }),
      'QUALIFIED',
      undefined,
    );
    expect(ok.ok).toBe(true);
  });

  it('BOOKED needs consent, accepted quote and booking advance', () => {
    const s = snapshot({
      stage: 'QUOTED',
      facts: { contact_consent: true, quote_accepted_indicative: true },
    });
    const r = planStageTransition(s, 'BOOKED', undefined);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'GATE_FAILED') {
      expect(r.error.unmet.map((u) => u.fact)).toEqual(['booking_advance']);
    }
  });

  it('READY_TO_INSTALL needs funds, DISCOM feasibility and delivered material', () => {
    const s = snapshot({
      stage: 'DESIGN_APPROVED',
      facts: { funds_secured: true },
      workstreams: {
        ...initialWorkstreams(),
        regulatory: 'FEASIBILITY_SUBMITTED',
        procurement: 'DELIVERED',
      },
    });
    const r = planStageTransition(s, 'READY_TO_INSTALL', undefined);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'GATE_FAILED') {
      expect(r.error.unmet.map((u) => u.id)).toEqual(['workstream:regulatory']);
    }
    const approved = {
      ...s,
      workstreams: { ...s.workstreams, regulatory: 'FEASIBILITY_APPROVED' as const },
    };
    expect(planStageTransition(approved, 'READY_TO_INSTALL', undefined).ok).toBe(true);
  });

  it('feasibility rejection does not count as reaching approval', () => {
    const s = snapshot({
      stage: 'DESIGN_APPROVED',
      facts: { funds_secured: true },
      workstreams: {
        ...initialWorkstreams(),
        regulatory: 'FEASIBILITY_REJECTED',
        procurement: 'DELIVERED',
      },
    });
    expect(planStageTransition(s, 'READY_TO_INSTALL', undefined).ok).toBe(false);
  });

  it('closing does not wait for subsidy release', () => {
    const s = everythingDone('HANDED_OVER');
    s.workstreams.regulatory = 'COMMISSIONED';
    expect(planStageTransition(s, 'CLOSED', undefined).ok).toBe(true);
  });

  it('resuming from hold re-checks the gate', () => {
    const s = snapshot({ stage: 'ON_HOLD', heldFromStage: 'QUALIFIED' });
    const r = planStageTransition(s, 'QUALIFIED', undefined);
    expect(r.ok).toBe(false);
  });
});

describe('reasons', () => {
  it('side and backward moves require a reason; forward moves do not', () => {
    const s = everythingDone('SURVEYED');
    expect(planStageTransition(s, 'ON_HOLD', '  ').ok).toBe(false);
    expect(planStageTransition(s, 'BOOKED', undefined).ok).toBe(false);
    expect(planStageTransition(s, 'BOOKED', 'roof measurements wrong').ok).toBe(true);
    expect(planStageTransition(s, 'DESIGN_APPROVED', undefined).ok).toBe(true);
  });

  it('going on hold remembers where to resume', () => {
    const r = planStageTransition(everythingDone('BOOKED'), 'ON_HOLD', 'customer travelling');
    expect(r).toEqual({
      ok: true,
      value: { from: 'BOOKED', to: 'ON_HOLD', heldFromStage: 'BOOKED' },
    });
  });
});

describe('stageOptions', () => {
  it('lists gate requirements for forward moves only', () => {
    const opts = stageOptions(snapshot({ stage: 'QUOTED' }));
    const booked = opts.find((o) => o.to === 'BOOKED');
    const back = opts.find((o) => o.to === 'QUALIFIED');
    expect(booked?.requirements.map((r) => r.fact)).toEqual([
      'contact_consent',
      'quote_accepted_indicative',
      'booking_advance',
    ]);
    expect(booked?.reasonRequired).toBe(false);
    expect(back?.requirements).toEqual([]);
    expect(back?.reasonRequired).toBe(true);
  });
});

describe('workstream transition matrix', () => {
  for (const w of WORKSTREAM_NAMES) {
    const def = WORKSTREAMS[w];
    const edges = def.edges as Record<string, readonly string[]>;
    it(`${w}: every declared edge is allowed and every other pair rejected`, () => {
      for (const from of def.states) {
        for (const to of def.states) {
          const r = planWorkstreamTransition(w, from as never, to as never);
          expect(r.ok, `${w} ${from} → ${to}`).toBe(edges[from]!.includes(to));
        }
      }
    });

    it(`${w}: edges only reference declared states and every state is reachable`, () => {
      const states = new Set<string>(def.states);
      const reachable = new Set<string>([def.initial]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const s of [...reachable]) {
          for (const t of edges[s] ?? []) {
            expect(states.has(t)).toBe(true);
            if (!reachable.has(t)) {
              reachable.add(t);
              grew = true;
            }
          }
        }
      }
      expect([...reachable].sort()).toEqual([...states].sort());
    });
  }
});
