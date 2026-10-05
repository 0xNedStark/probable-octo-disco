import type { Role } from './roles';

/**
 * Every human checkpoint is a task (PLAN §2 item 4). Effort minutes captured on
 * completion feed the "human ops hours per project" metric.
 */
export const TASK_TYPES = {
  first_contact: { label: 'Contact new lead', slaMinutes: 5, defaultRole: 'sales' },
  bill_review: { label: 'Review bill and enter readings', slaMinutes: 60, defaultRole: 'ops' },
  bill_resubmit_follow_up: {
    label: 'Follow up for clearer bill',
    slaMinutes: 24 * 60,
    defaultRole: 'sales',
  },
  quote_follow_up: { label: 'Follow up on sent quote', slaMinutes: 24 * 60, defaultRole: 'sales' },
  general: { label: 'General', slaMinutes: 24 * 60, defaultRole: 'ops' },
} as const satisfies Record<string, { label: string; slaMinutes: number; defaultRole: Role }>;

export type TaskType = keyof typeof TASK_TYPES;
export const TASK_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskType(value: string): value is TaskType {
  return value in TASK_TYPES;
}

export function taskDueAt(type: TaskType, from: Date): Date {
  return new Date(from.getTime() + TASK_TYPES[type].slaMinutes * 60_000);
}
