import { can, type Permission, type Role } from '@solar/domain';

/** Who is performing a service call. Users carry their role for permission checks. */
export type ServiceActor =
  | { type: 'user'; id: string; role: Role }
  | { type: 'system'; id: string }
  | { type: 'agent'; id: string };

export const SYSTEM: ServiceActor = { type: 'system', id: 'system' };

export class ServiceError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** Users need the permission; system and agent actors act on behalf of the platform. */
export function authorize(actor: ServiceActor, permission: Permission): void {
  if (actor.type === 'user' && !can(actor.role, permission)) {
    throw new ServiceError('FORBIDDEN', `Role ${actor.role} lacks ${permission}.`);
  }
}
