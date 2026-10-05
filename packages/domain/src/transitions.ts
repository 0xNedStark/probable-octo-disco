import { requirementsFor, type ProjectSnapshot, type Requirement } from './gates';
import {
  isMainStage,
  isTerminal,
  nextStages,
  type MainStage,
  type Stage,
  stageIndex,
} from './stages';
import { workstreamNext, type Workstream, type WorkstreamState } from './workstreams';

export type ActorType = 'user' | 'agent' | 'system';

export interface Actor {
  type: ActorType;
  id: string;
}

export interface StageSnapshot extends ProjectSnapshot {
  stage: Stage;
  heldFromStage: MainStage | null;
}

export type TransitionError =
  | { code: 'TERMINAL'; message: string }
  | { code: 'ILLEGAL_TRANSITION'; message: string }
  | { code: 'REASON_REQUIRED'; message: string }
  | { code: 'GATE_FAILED'; message: string; unmet: Requirement[] };

export type Result<T> = { ok: true; value: T } | { ok: false; error: TransitionError };

export interface PlannedStageTransition {
  from: Stage;
  to: Stage;
  /** Value to store as the project's held-from stage after the move. */
  heldFromStage: MainStage | null;
}

const err = (error: TransitionError): { ok: false; error: TransitionError } => ({
  ok: false,
  error,
});

function isBackwards(from: Stage, to: Stage): boolean {
  return isMainStage(from) && isMainStage(to) && stageIndex(to) < stageIndex(from);
}

/** Side moves and backwards (rework) moves need a reason; forward moves are justified by gates. */
function needsReason(from: Stage, to: Stage): boolean {
  return !isMainStage(to) || isBackwards(from, to);
}

/** Gates apply to forward moves into a main stage, including resuming from hold. */
function gated(from: Stage, to: Stage): to is MainStage {
  return isMainStage(to) && !isBackwards(from, to);
}

/**
 * Decide whether a stage move is allowed. Pure: the caller loads the snapshot
 * under a row lock and persists the result together with its event.
 */
export function planStageTransition(
  s: StageSnapshot,
  to: Stage,
  reason: string | undefined,
): Result<PlannedStageTransition> {
  const from = s.stage;
  if (isTerminal(from)) {
    return err({ code: 'TERMINAL', message: `Project is ${from}; no further moves.` });
  }
  if (!nextStages(from, s.heldFromStage).includes(to)) {
    return err({ code: 'ILLEGAL_TRANSITION', message: `Cannot move from ${from} to ${to}.` });
  }
  if (needsReason(from, to) && !reason?.trim()) {
    return err({ code: 'REASON_REQUIRED', message: `Moving to ${to} requires a reason.` });
  }

  // Resuming from hold is gated too: the world may have changed while paused.
  if (gated(from, to)) {
    const unmet = requirementsFor(to, s).filter((r) => !r.met);
    if (unmet.length > 0) {
      return err({
        code: 'GATE_FAILED',
        message: `Requirements for ${to} not met: ${unmet.map((r) => r.label).join('; ')}.`,
        unmet,
      });
    }
  }

  let heldFromStage: MainStage | null = null;
  if (to === 'ON_HOLD') heldFromStage = from as MainStage;
  return { ok: true, value: { from, to, heldFromStage } };
}

export function planWorkstreamTransition<W extends Workstream>(
  w: W,
  from: WorkstreamState<W>,
  to: WorkstreamState<W>,
): Result<{ from: WorkstreamState<W>; to: WorkstreamState<W> }> {
  if (!workstreamNext(w, from).includes(to)) {
    return err({ code: 'ILLEGAL_TRANSITION', message: `${w}: cannot move from ${from} to ${to}.` });
  }
  return { ok: true, value: { from, to } };
}

/** Allowed next stages with their gate status, for rendering in the ops console. */
export function stageOptions(
  s: StageSnapshot,
): { to: Stage; requirements: Requirement[]; reasonRequired: boolean }[] {
  return nextStages(s.stage, s.heldFromStage).map((to) => ({
    to,
    requirements: gated(s.stage, to) ? requirementsFor(to, s) : [],
    reasonRequired: needsReason(s.stage, to),
  }));
}
