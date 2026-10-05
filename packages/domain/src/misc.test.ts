import { describe, expect, it } from 'vitest';
import { canAttest } from './facts';
import { newId, projectCode } from './ids';
import { normaliseIndianMobile } from './phone';
import { can } from './roles';
import { taskDueAt } from './tasks';

describe('normaliseIndianMobile', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['091-98765-43210', null],
    ['09876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['5876543210', null],
    ['98765', null],
  ])('%s → %s', (input, expected) => {
    expect(normaliseIndianMobile(input)).toBe(expected);
  });
});

describe('ids', () => {
  it('prefixes ids and formats project codes', () => {
    expect(newId('project')).toMatch(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(projectCode(2026, 127)).toBe('SOL-2026-00127');
  });
});

describe('permissions', () => {
  it('only engineers and admins attest engineering approval', () => {
    expect(canAttest('engineer', 'survey_approved_by_engineer')).toBe(true);
    expect(canAttest('ops', 'survey_approved_by_engineer')).toBe(false);
    expect(canAttest('admin', 'survey_approved_by_engineer')).toBe(true);
  });

  it('consent can never be attested manually', () => {
    expect(canAttest('admin', 'contact_consent')).toBe(false);
  });

  it('field roles have no ops-console permissions', () => {
    expect(can('installer', 'project.view')).toBe(false);
    expect(can('ops', 'users.manage')).toBe(false);
    expect(can('admin', 'users.manage')).toBe(true);
  });
});

describe('tasks', () => {
  it('first contact is due within the 5 minute response target', () => {
    const t0 = new Date('2026-10-05T10:00:00Z');
    expect(taskDueAt('first_contact', t0).toISOString()).toBe('2026-10-05T10:05:00.000Z');
  });
});
