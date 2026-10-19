const { validateLayout } = require('../../db/appGroupsDb');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const G = '44444444-4444-4444-8444-444444444444';

describe('dashboard layout validation', () => {
  it('accepts groups in order, new and existing, plus ungrouped apps', () => {
    const r = validateLayout({ groups: [{ id: G, name: '  Logistics   & Shipping ', apps: [A, B] }, { name: 'Finance', apps: [] }], ungrouped: [C] });
    expect(r.error).toBeUndefined();
    expect(r.value.groups).toEqual([
      { id: G, name: 'Logistics & Shipping', apps: [A, B] },
      { id: null, name: 'Finance', apps: [] },
    ]);
    expect(r.value.appIds.sort()).toEqual([A, B, C].sort());
  });

  it('allows an empty layout (removes every group)', () => {
    expect(validateLayout({ groups: [] }).value).toEqual({ groups: [], ungrouped: [], appIds: [] });
  });

  it.each([
    ['missing groups list', {}, /lists/],
    ['an unnamed group', { groups: [{ name: '  ', apps: [] }] }, /needs a name/],
    ['a too-long name', { groups: [{ name: 'x'.repeat(61), apps: [] }] }, /60 characters/],
    ['two groups with the same name (any case)', { groups: [{ name: 'Finance', apps: [] }, { name: 'finance', apps: [] }] }, /two groups called/],
    ['an app in two groups', { groups: [{ name: 'A', apps: [A] }, { name: 'B', apps: [A] }] }, /only be in one group/],
    ['an app both grouped and ungrouped', { groups: [{ name: 'A', apps: [A] }], ungrouped: [A] }, /only be in one group/],
    ['a non-uuid app id', { groups: [{ name: 'A', apps: ["1'; DROP TABLE applications;--"] }] }, /Invalid application id/],
    ['a non-uuid group id', { groups: [{ id: 'abc', name: 'A', apps: [] }] }, /Invalid group id/],
    ['the same group id twice', { groups: [{ id: G, name: 'A', apps: [] }, { id: G, name: 'B', apps: [] }] }, /Invalid group id/],
    ['too many groups', { groups: Array.from({ length: 51 }, (_, i) => ({ name: `G${i}`, apps: [] })) }, /At most 50/],
  ])('rejects %s', (_label, body, message) => {
    expect(validateLayout(body).error).toMatch(message);
  });
});
