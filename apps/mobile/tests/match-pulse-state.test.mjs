import assert from 'node:assert/strict';
import test from 'node:test';

import { getVisiblePulseLoadState } from '../src/hooks/match-pulse-state.ts';
import { resolveMatchDetail } from '../src/screens/match-detail-route-state.ts';

const match = {
  txline: { fixtureId: '18179759' },
};

test('hides commentary belonging to the previously viewed fixture', () => {
  const visible = getVisiblePulseLoadState({
    status: 'ready',
    fixtureId: 'old-fixture',
    entries: [{ id: 'old-entry' }],
  }, '18179759');

  assert.deepEqual(visible, {
    status: 'loading',
    fixtureId: '18179759',
    entries: [],
  });
});

test('resolves a durable completed fixture from the saved match list', () => {
  const resolution = resolveMatchDetail({ status: 'ready', matches: [match] }, '18179759');

  assert.equal(resolution.status, 'ready');
  assert.equal(resolution.match, match);
});

test('returns not_found instead of loading forever when a ready list omits the fixture', () => {
  const resolution = resolveMatchDetail({ status: 'ready', matches: [match] }, 'missing');

  assert.deepEqual(resolution, { status: 'not_found' });
});
