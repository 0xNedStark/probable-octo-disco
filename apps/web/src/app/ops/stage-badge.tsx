import { STAGE_LABELS, type Stage } from '@solar/domain';

const TONE: Partial<Record<Stage, string>> = {
  ON_HOLD: 'warn',
  CANCELLED: 'bad',
  LOST: 'bad',
  CLOSED: 'ok',
  COMMISSIONED: 'ok',
};

export function StageBadge({ stage }: { stage: Stage }) {
  return <span className={`badge ${TONE[stage] ?? ''}`}>{STAGE_LABELS[stage]}</span>;
}
