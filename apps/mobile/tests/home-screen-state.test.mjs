import assert from 'node:assert/strict';
import test from 'node:test';

import {
  partitionHomeMatches,
  resolveHomeSection,
} from '../src/screens/home-screen-state.ts';

function match(fixtureId, status, kickoffUtc) {
  return {
    id: `match-${fixtureId}`,
    txline: { fixtureId },
    status,
    kickoffUtc,
  };
}

test('partitions canonical matches and preserves supplied featured order', () => {
  const upcoming = match('upcoming-first', 'upcoming', '2026-07-15T18:00:00Z');
  const replayable = match('replay', 'replayable', '2026-07-12T18:00:00Z');
  const live = match('live-second', 'live', '2026-07-13T18:00:00Z');
  const hosted = match('hosted', 'hosted', '2026-07-14T18:00:00Z');
  const finished = match('finished', 'finished', '2026-07-11T18:00:00Z');

  const sections = partitionHomeMatches([
    upcoming,
    replayable,
    live,
    hosted,
    finished,
  ]);

  assert.deepEqual(sections.featuredMatches, [upcoming, live]);
  assert.deepEqual(sections.recentMatches, [replayable, finished]);
});

test('orders recent matches by newest kickoff then fixture id', () => {
  const older = match('30', 'finished', '2026-07-10T18:00:00Z');
  const tiedLaterId = match('20', 'replayable', '2026-07-12T18:00:00Z');
  const tiedEarlierId = match('10', 'finished', '2026-07-12T18:00:00Z');

  const sections = partitionHomeMatches([older, tiedLaterId, tiedEarlierId]);

  assert.deepEqual(sections.recentMatches, [tiedEarlierId, tiedLaterId, older]);
});

test('does not mutate the supplied match list', () => {
  const first = match('older', 'finished', '2026-07-10T18:00:00Z');
  const second = match('newer', 'replayable', '2026-07-12T18:00:00Z');
  const matches = [first, second];

  partitionHomeMatches(matches);

  assert.deepEqual(matches, [first, second]);
});

test('switches from featured only after crossing the lower hysteresis edge', () => {
  assert.equal(resolveHomeSection('featured', 131, 100, 32), 'featured');
  assert.equal(resolveHomeSection('featured', 132, 100, 32), 'featured');
  assert.equal(resolveHomeSection('featured', 133, 100, 32), 'recent');
});

test('switches from recent only after crossing the upper hysteresis edge', () => {
  assert.equal(resolveHomeSection('recent', 69, 100, 32), 'recent');
  assert.equal(resolveHomeSection('recent', 68, 100, 32), 'recent');
  assert.equal(resolveHomeSection('recent', 67, 100, 32), 'featured');
});

test('keeps the current section throughout the dead band', () => {
  for (const scrollOffsetY of [68, 84, 100, 116, 132]) {
    assert.equal(
      resolveHomeSection('featured', scrollOffsetY, 100, 32),
      'featured',
    );
    assert.equal(
      resolveHomeSection('recent', scrollOffsetY, 100, 32),
      'recent',
    );
  }
});
