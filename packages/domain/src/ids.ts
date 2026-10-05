import { ulid } from 'ulid';

export const ID_PREFIXES = {
  user: 'usr',
  session: 'ses',
  customer: 'cus',
  consent: 'cns',
  lead: 'led',
  project: 'prj',
  bill: 'bil',
  reading: 'rdg',
  event: 'evt',
  fact: 'fct',
  task: 'tsk',
  outbox: 'obx',
  fileAccess: 'fax',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** Sortable, prefixed identifiers, e.g. `prj_01JABC...`. */
export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

/** Human-facing project code, e.g. SOL-2026-00127 (spec Appendix A). */
export function projectCode(year: number, sequence: number): string {
  return `SOL-${year}-${String(sequence).padStart(5, '0')}`;
}
