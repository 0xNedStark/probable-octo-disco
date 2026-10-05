/**
 * Project stage: the coarse, customer-visible progression (docs/PLAN.md §4.1).
 * Detailed progress lives in workstreams; stage moves are gated on them.
 */
export const MAIN_STAGES = [
  'LEAD',
  'QUALIFIED',
  'QUOTED',
  'BOOKED',
  'SURVEYED',
  'DESIGN_APPROVED',
  'READY_TO_INSTALL',
  'INSTALLED',
  'QA_PASSED',
  'COMMISSIONED',
  'HANDED_OVER',
  'CLOSED',
] as const;

export const SIDE_STAGES = ['ON_HOLD', 'CANCELLED', 'LOST'] as const;

export type MainStage = (typeof MAIN_STAGES)[number];
export type SideStage = (typeof SIDE_STAGES)[number];
export type Stage = MainStage | SideStage;

export const TERMINAL_STAGES: readonly Stage[] = ['CLOSED', 'CANCELLED', 'LOST'];

export const STAGE_LABELS: Record<Stage, string> = {
  LEAD: 'Lead',
  QUALIFIED: 'Qualified',
  QUOTED: 'Quoted',
  BOOKED: 'Booked',
  SURVEYED: 'Surveyed',
  DESIGN_APPROVED: 'Design approved',
  READY_TO_INSTALL: 'Ready to install',
  INSTALLED: 'Installed',
  QA_PASSED: 'QA passed',
  COMMISSIONED: 'Commissioned',
  HANDED_OVER: 'Handed over',
  CLOSED: 'Closed',
  ON_HOLD: 'On hold',
  CANCELLED: 'Cancelled',
  LOST: 'Lost',
};

/** Explicit rework edges; everything else is "next main stage" or a side stage. */
const REWORK_EDGES: Partial<Record<MainStage, MainStage[]>> = {
  QUOTED: ['QUALIFIED'], // new bill or re-qualification
  SURVEYED: ['BOOKED'], // re-survey
  DESIGN_APPROVED: ['SURVEYED'], // design reopened
};

export function isMainStage(stage: string): stage is MainStage {
  return (MAIN_STAGES as readonly string[]).includes(stage);
}

export function isStage(stage: string): stage is Stage {
  return isMainStage(stage) || (SIDE_STAGES as readonly string[]).includes(stage);
}

export function isTerminal(stage: Stage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

export function stageIndex(stage: MainStage): number {
  return MAIN_STAGES.indexOf(stage);
}

/** A customer who has paid (BOOKED or later) cancels; before that, the lead is lost. */
export function exitStageFor(stage: MainStage): 'CANCELLED' | 'LOST' {
  return stageIndex(stage) >= stageIndex('BOOKED') ? 'CANCELLED' : 'LOST';
}

/** Once installation starts, cancellation is a warranty/grievance matter, not a stage move (PLAN §3C). */
export function canExit(stage: MainStage): boolean {
  return stageIndex(stage) < stageIndex('INSTALLED');
}

/**
 * Stages reachable from `from`, ignoring gates. `heldFrom` is the stage a project
 * was in before going ON_HOLD; it is the only place ON_HOLD can resume to.
 */
export function nextStages(from: Stage, heldFrom: MainStage | null): Stage[] {
  if (isTerminal(from)) return [];
  if (from === 'ON_HOLD') {
    if (!heldFrom) return [];
    return canExit(heldFrom) ? [heldFrom, exitStageFor(heldFrom)] : [heldFrom];
  }
  if (!isMainStage(from)) return [];
  const out: Stage[] = [];
  const next = MAIN_STAGES[stageIndex(from) + 1];
  if (next) out.push(next);
  out.push(...(REWORK_EDGES[from] ?? []));
  out.push('ON_HOLD');
  if (canExit(from)) out.push(exitStageFor(from));
  return out;
}
