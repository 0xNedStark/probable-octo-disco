export const ROLES = [
  'admin',
  'ops',
  'sales',
  'engineer',
  'finance',
  'installer',
  'technician',
] as const;

export type Role = (typeof ROLES)[number];

/** Staff roles that may use the ops console. Installers/technicians get the field PWA instead. */
export const STAFF_ROLES: readonly Role[] = ['admin', 'ops', 'sales', 'engineer', 'finance'];

export type Permission =
  | 'project.view'
  | 'project.transition'
  | 'workstream.transition'
  | 'bill.enter_readings'
  | 'file.read_personal'
  | 'task.work'
  | 'quote.manage'
  | 'config.manage'
  | 'payment.manage'
  | 'finance.manage'
  | 'message.send'
  | 'users.manage';

const GRANTS: Record<Role, readonly Permission[]> = {
  admin: [
    'project.view',
    'project.transition',
    'workstream.transition',
    'bill.enter_readings',
    'file.read_personal',
    'task.work',
    'quote.manage',
    'config.manage',
    'payment.manage',
    'finance.manage',
    'message.send',
    'users.manage',
  ],
  ops: [
    'project.view',
    'project.transition',
    'workstream.transition',
    'bill.enter_readings',
    'file.read_personal',
    'task.work',
    'quote.manage',
    'finance.manage',
    'message.send',
  ],
  sales: [
    'project.view',
    'bill.enter_readings',
    'file.read_personal',
    'task.work',
    'quote.manage',
    'message.send',
  ],
  engineer: ['project.view', 'file.read_personal', 'task.work'],
  finance: [
    'project.view',
    'workstream.transition',
    'file.read_personal',
    'task.work',
    'payment.manage',
    'finance.manage',
  ],
  installer: [],
  technician: [],
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].includes(permission);
}
