import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatTransportStripLabel,
  resolveTransportButtonAction,
  resolveTransportStripButtonDisabled,
  resolveTransportStripIsPaused,
  resolveTransportStripLabel,
  shouldShowBackToFullTime,
} from '../src/screens/match-transport-strip-logic.ts';

// ---------------------------------------------------------------------------
// resolveTransportStripLabel / formatTransportStripLabel
// ---------------------------------------------------------------------------

test('finished + idle reads Full time', () => {
  const label = resolveTransportStripLabel({
    currentMinute: undefined,
    gameViewIntent: 'idle',
    matchStatus: 'finished',
    playbackMode: 'paused',
  });
  assert.deepEqual(label, { kind: 'full_time' });
  assert.equal(formatTransportStripLabel(label), 'Full time');
});

test('replayable + idle also reads Full time', () => {
  const label = resolveTransportStripLabel({
    currentMinute: undefined,
    gameViewIntent: 'idle',
    matchStatus: 'replayable',
    playbackMode: 'paused',
  });
  assert.equal(formatTransportStripLabel(label), 'Full time');
});

test('playing highlights reads Playing highlights regardless of minute', () => {
  const label = resolveTransportStripLabel({
    currentMinute: 42,
    gameViewIntent: 'highlights',
    matchStatus: 'finished',
    playbackMode: 'replay',
  });
  assert.deepEqual(label, { kind: 'playing_highlights' });
  assert.equal(formatTransportStripLabel(label), 'Playing highlights');
});

test('full replay reads Replay {minute}\'', () => {
  const label = resolveTransportStripLabel({
    currentMinute: 57,
    gameViewIntent: 'full',
    matchStatus: 'finished',
    playbackMode: 'replay',
  });
  assert.deepEqual(label, { kind: 'replay', minute: 57 });
  assert.equal(formatTransportStripLabel(label), "Replay 57'");
});

test('full replay with an unknown minute still reads a graceful label', () => {
  const label = resolveTransportStripLabel({
    currentMinute: undefined,
    gameViewIntent: 'full',
    matchStatus: 'finished',
    playbackMode: 'replay',
  });
  assert.equal(formatTransportStripLabel(label), 'Replay');
});

test('a single checkpoint clip reads Watching {minute}\' moment', () => {
  const label = resolveTransportStripLabel({
    currentMinute: 23,
    gameViewIntent: 'clip',
    matchStatus: 'finished',
    playbackMode: 'replay',
  });
  assert.deepEqual(label, { kind: 'clip', minute: 23 });
  assert.equal(formatTransportStripLabel(label), "Watching 23' moment");
});

test('a live match reads LIVE regardless of gameViewIntent', () => {
  const label = resolveTransportStripLabel({
    currentMinute: 12,
    gameViewIntent: 'idle',
    matchStatus: 'live',
    playbackMode: 'live',
  });
  assert.deepEqual(label, { kind: 'live' });
  assert.equal(formatTransportStripLabel(label), 'LIVE');
});

test('a live match paused mid-tail still reads LIVE (status wins over playbackMode)', () => {
  const label = resolveTransportStripLabel({
    currentMinute: 12,
    gameViewIntent: 'idle',
    matchStatus: 'live',
    playbackMode: 'paused',
  });
  assert.equal(formatTransportStripLabel(label), 'LIVE');
});

// ---------------------------------------------------------------------------
// Upcoming/hosted kickoff state (item 4, fix round)
// ---------------------------------------------------------------------------

test('an upcoming fixture reads a Kickoff label regardless of gameViewIntent/playbackMode', () => {
  const label = resolveTransportStripLabel({
    currentMinute: 5,
    gameViewIntent: 'idle',
    kickoffLabel: 'Mon 00:30',
    matchStatus: 'upcoming',
    playbackMode: 'replay',
  });
  assert.deepEqual(label, { kind: 'kickoff', kickoffLabel: 'Mon 00:30' });
  assert.equal(formatTransportStripLabel(label), 'Kickoff Mon 00:30');
});

test('a hosted fixture also reads a Kickoff label', () => {
  const label = resolveTransportStripLabel({
    currentMinute: undefined,
    gameViewIntent: 'idle',
    kickoffLabel: 'Sat 15:00',
    matchStatus: 'hosted',
    playbackMode: 'paused',
  });
  assert.deepEqual(label, { kind: 'kickoff', kickoffLabel: 'Sat 15:00' });
});

test('a Kickoff label with no threaded time still reads gracefully', () => {
  const label = resolveTransportStripLabel({
    currentMinute: undefined,
    gameViewIntent: 'idle',
    kickoffLabel: undefined,
    matchStatus: 'upcoming',
    playbackMode: 'paused',
  });
  assert.equal(formatTransportStripLabel(label), 'Kickoff');
});

test('upcoming/hosted: the button action is none (disabled, taps no-op)', () => {
  assert.deepEqual(
    resolveTransportButtonAction({ gameViewIntent: 'idle', isPaused: false, matchStatus: 'upcoming' }),
    { kind: 'none' },
  );
  assert.deepEqual(
    resolveTransportButtonAction({ gameViewIntent: 'idle', isPaused: false, matchStatus: 'hosted' }),
    { kind: 'none' },
  );
});

test('resolveTransportStripButtonDisabled is true only for upcoming/hosted', () => {
  assert.equal(resolveTransportStripButtonDisabled('upcoming'), true);
  assert.equal(resolveTransportStripButtonDisabled('hosted'), true);
  assert.equal(resolveTransportStripButtonDisabled('live'), false);
  assert.equal(resolveTransportStripButtonDisabled('finished'), false);
  assert.equal(resolveTransportStripButtonDisabled('replayable'), false);
});

// ---------------------------------------------------------------------------
// resolveTransportStripIsPaused (item 3, fix round)
// ---------------------------------------------------------------------------

test('idle (full time, nothing playing) always reads paused/play-glyph, regardless of the caller\'s own flag', () => {
  assert.equal(
    resolveTransportStripIsPaused({ gameViewIntent: 'idle', isPausedByStrip: false, matchStatus: 'finished' }),
    true,
  );
  assert.equal(
    resolveTransportStripIsPaused({ gameViewIntent: 'idle', isPausedByStrip: true, matchStatus: 'replayable' }),
    true,
  );
});

test('upcoming/hosted always reads paused/play-glyph too', () => {
  assert.equal(
    resolveTransportStripIsPaused({ gameViewIntent: 'idle', isPausedByStrip: false, matchStatus: 'upcoming' }),
    true,
  );
});

test('actively playing (clip/highlights/full) defers to the caller\'s own explicit pause flag', () => {
  assert.equal(
    resolveTransportStripIsPaused({ gameViewIntent: 'full', isPausedByStrip: false, matchStatus: 'finished' }),
    false,
  );
  assert.equal(
    resolveTransportStripIsPaused({ gameViewIntent: 'full', isPausedByStrip: true, matchStatus: 'finished' }),
    true,
  );
});

test('a live match always defers to the caller\'s own explicit pause flag, even though gameViewIntent stays idle', () => {
  assert.equal(
    resolveTransportStripIsPaused({ gameViewIntent: 'idle', isPausedByStrip: false, matchStatus: 'live' }),
    false,
  );
  assert.equal(
    resolveTransportStripIsPaused({ gameViewIntent: 'idle', isPausedByStrip: true, matchStatus: 'live' }),
    true,
  );
});

// ---------------------------------------------------------------------------
// resolveTransportButtonAction
// ---------------------------------------------------------------------------

test('finished + idle: the button starts the full replay', () => {
  assert.deepEqual(
    resolveTransportButtonAction({ gameViewIntent: 'idle', isPaused: false, matchStatus: 'finished' }),
    { kind: 'start_full_replay' },
  );
});

test('finished + actively playing (not paused): the button pauses', () => {
  assert.deepEqual(
    resolveTransportButtonAction({ gameViewIntent: 'full', isPaused: false, matchStatus: 'finished' }),
    { kind: 'pause' },
  );
  assert.deepEqual(
    resolveTransportButtonAction({ gameViewIntent: 'highlights', isPaused: false, matchStatus: 'finished' }),
    { kind: 'pause' },
  );
  assert.deepEqual(
    resolveTransportButtonAction({ gameViewIntent: 'clip', isPaused: false, matchStatus: 'finished' }),
    { kind: 'pause' },
  );
});

test('finished + paused mid-playback: the button resumes', () => {
  assert.deepEqual(
    resolveTransportButtonAction({ gameViewIntent: 'full', isPaused: true, matchStatus: 'finished' }),
    { kind: 'resume' },
  );
});

test('live + not paused: the button pauses the live tail', () => {
  assert.deepEqual(
    resolveTransportButtonAction({ gameViewIntent: 'idle', isPaused: false, matchStatus: 'live' }),
    { kind: 'pause' },
  );
});

test('live + paused: the button returns to the live head', () => {
  assert.deepEqual(
    resolveTransportButtonAction({ gameViewIntent: 'idle', isPaused: true, matchStatus: 'live' }),
    { kind: 'return_to_live' },
  );
});

// ---------------------------------------------------------------------------
// shouldShowBackToFullTime
// ---------------------------------------------------------------------------

test('back-to-full-time affordance is hidden while idle (nothing to stop back to)', () => {
  assert.equal(shouldShowBackToFullTime('finished', 'idle'), false);
  assert.equal(shouldShowBackToFullTime('replayable', 'idle'), false);
});

test('back-to-full-time affordance shows for a finished match with something playing', () => {
  assert.equal(shouldShowBackToFullTime('finished', 'full'), true);
  assert.equal(shouldShowBackToFullTime('finished', 'highlights'), true);
  assert.equal(shouldShowBackToFullTime('finished', 'clip'), true);
  assert.equal(shouldShowBackToFullTime('replayable', 'full'), true);
});

test('back-to-full-time affordance never shows for a live match', () => {
  assert.equal(shouldShowBackToFullTime('live', 'full'), false);
  assert.equal(shouldShowBackToFullTime('live', 'idle'), false);
});

test('back-to-full-time affordance never shows for upcoming/hosted', () => {
  assert.equal(shouldShowBackToFullTime('upcoming', 'full'), false);
  assert.equal(shouldShowBackToFullTime('hosted', 'full'), false);
});
