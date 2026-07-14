import assert from 'node:assert/strict';
import test from 'node:test';

import { getTeamColor } from '../src/screens/game-view/game-view-team-colors.ts';

test('getTeamColor picks a readable (not near-black/near-white) band', () => {
  assert.equal(getTeamColor(['#000000', '#2D6CDF', '#FFFFFF'], '#123456'), '#2D6CDF');
});

test('getTeamColor falls back to the first band when no band is readable but bands is non-empty', () => {
  // candidates is empty (both bands fail the readability filter), so the
  // fallback chain is candidates[0] ?? bands[0] ?? fallback -- bands[0] wins.
  assert.equal(getTeamColor(['#000000', '#FFFFFF'], '#123456'), '#000000');
});

test('getTeamColor falls back to the fallback color when bands is empty', () => {
  assert.equal(getTeamColor([], '#123456'), '#123456');
});

test('getTeamColor avoids colliding with the other team\'s chosen color when possible', () => {
  // Two readable candidates roughly equidistant in hue but different
  // brightness from avoidColor's channels -- picks whichever sorts as most
  // different by Euclidean RGB distance.
  const color = getTeamColor(['#2D6CDF', '#F5A623'], '#123456', '#E23546');
  assert.equal(color, '#2D6CDF');
});

test('getTeamColor with a single readable candidate ignores avoidColor', () => {
  assert.equal(getTeamColor(['#000000', '#2D6CDF'], '#123456', '#2D6CDF'), '#2D6CDF');
});
