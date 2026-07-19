import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyListeningSessionAction,
  buildListeningSessionLabel,
  decideListeningSessionEnter,
  decideScreenDetachAction,
  deriveNowListeningBarVisible,
  IDLE_LISTENING_SESSION_STATE,
  isListeningSessionEngineAdvancing,
  shouldPreferenceDisableStopSession,
  shouldStopOnScreenLeave,
} from '../src/state/commentary-listening-session-logic.ts';

function info(fixtureId, overrides = {}) {
  return { fixtureId, label: `label:${fixtureId}`, isLive: false, ...overrides };
}

test('entering a match with no existing session starts fresh', () => {
  assert.deepEqual(decideListeningSessionEnter(undefined, 'f1'), { kind: 'start' });
});

test('entering the SAME fixture already active adopts, does not restart', () => {
  assert.deepEqual(decideListeningSessionEnter(info('f1'), 'f1'), { kind: 'adopt' });
});

test('entering a DIFFERENT fixture swaps: old session stops, new one starts', () => {
  assert.deepEqual(decideListeningSessionEnter(info('f1'), 'f2'), { kind: 'swap' });
});

test('leaving the match screen never stops the session by itself', () => {
  assert.equal(shouldStopOnScreenLeave(), false);
});

// ---------------------------------------------------------------------------
// decideScreenDetachAction (round 5/item 4: status-based headless rule)
// ---------------------------------------------------------------------------

test('decideScreenDetachAction persists the session headless for a live match', () => {
  assert.deepEqual(decideScreenDetachAction(true), { kind: 'persist' });
});

test('decideScreenDetachAction stops the session outright for a finished match', () => {
  assert.deepEqual(decideScreenDetachAction(false), { kind: 'stop' });
});

// ---------------------------------------------------------------------------
// isListeningSessionEngineAdvancing (fix round item 3: never speak against a
// parked engine, e.g. a freshly re-entered finished match)
// ---------------------------------------------------------------------------

test('isListeningSessionEngineAdvancing is true only for live/replay', () => {
  assert.equal(isListeningSessionEngineAdvancing('live'), true);
  assert.equal(isListeningSessionEngineAdvancing('replay'), true);
});

test('isListeningSessionEngineAdvancing is false for a parked engine (paused/scrubbing)', () => {
  assert.equal(isListeningSessionEngineAdvancing('paused'), false);
  assert.equal(isListeningSessionEngineAdvancing('scrubbing'), false);
});

// ---------------------------------------------------------------------------
// shouldPreferenceDisableStopSession (bug fix: turning sound/voice off
// mid-match must not kill the driver while a screen is attached)
// ---------------------------------------------------------------------------

test('sound/voice disable does NOT stop the session while a screen is attached', () => {
  assert.equal(shouldPreferenceDisableStopSession(true), false);
});

test('sound/voice disable DOES stop the session while headless (no screen attached)', () => {
  assert.equal(shouldPreferenceDisableStopSession(false), true);
});

test('bar is hidden when no session is active', () => {
  assert.equal(deriveNowListeningBarVisible(IDLE_LISTENING_SESSION_STATE, undefined), false);
  assert.equal(deriveNowListeningBarVisible(IDLE_LISTENING_SESSION_STATE, 'f1'), false);
});

test('bar is hidden while the session is paused, even off the match screen', () => {
  const state = { active: info('f1'), isPlaying: false };
  assert.equal(deriveNowListeningBarVisible(state, undefined), false);
  assert.equal(deriveNowListeningBarVisible(state, 'f2'), false);
});

test('bar is hidden while the viewer is on that match\'s own screen', () => {
  const state = { active: info('f1'), isPlaying: true };
  assert.equal(deriveNowListeningBarVisible(state, 'f1'), false);
});

test('bar is visible while playing and the viewer is elsewhere (including Home, undefined)', () => {
  const state = { active: info('f1'), isPlaying: true };
  assert.equal(deriveNowListeningBarVisible(state, undefined), true);
  assert.equal(deriveNowListeningBarVisible(state, 'f2'), true);
});

test('label joins both team names', () => {
  assert.equal(buildListeningSessionLabel('England', 'Argentina'), 'England vs Argentina');
});

test('label trims whitespace-padded team names', () => {
  assert.equal(buildListeningSessionLabel('  England ', ' Argentina  '), 'England vs Argentina');
});

test('label falls back to whichever single team name is present', () => {
  assert.equal(buildListeningSessionLabel('England', ''), 'England');
  assert.equal(buildListeningSessionLabel('', 'Argentina'), 'Argentina');
});

test('label is empty when both team names are empty (defensive only)', () => {
  assert.equal(buildListeningSessionLabel('', ''), '');
  assert.equal(buildListeningSessionLabel('  ', '  '), '');
});

// -- applyListeningSessionAction: pause/resume/stop state transitions ------

test('enter sets the session active and playing', () => {
  const next = applyListeningSessionAction(IDLE_LISTENING_SESSION_STATE, { kind: 'enter', matchInfo: info('f1') });
  assert.deepEqual(next, { active: info('f1'), isPlaying: true });
});

test('entering while another session is already active replaces it outright (no merge)', () => {
  const state = { active: info('f1'), isPlaying: false };
  const next = applyListeningSessionAction(state, { kind: 'enter', matchInfo: info('f2') });
  assert.deepEqual(next, { active: info('f2'), isPlaying: true });
});

test('pause flips isPlaying false, keeps the active session', () => {
  const state = { active: info('f1'), isPlaying: true };
  const next = applyListeningSessionAction(state, { kind: 'pause' });
  assert.deepEqual(next, { active: info('f1'), isPlaying: false });
});

test('pausing an already-idle state is a no-op', () => {
  const next = applyListeningSessionAction(IDLE_LISTENING_SESSION_STATE, { kind: 'pause' });
  assert.deepEqual(next, IDLE_LISTENING_SESSION_STATE);
});

test('resume flips isPlaying true, keeps the active session', () => {
  const state = { active: info('f1'), isPlaying: false };
  const next = applyListeningSessionAction(state, { kind: 'resume' });
  assert.deepEqual(next, { active: info('f1'), isPlaying: true });
});

test('resuming an already-idle state is a no-op', () => {
  const next = applyListeningSessionAction(IDLE_LISTENING_SESSION_STATE, { kind: 'resume' });
  assert.deepEqual(next, IDLE_LISTENING_SESSION_STATE);
});

test('resuming an already-playing session is idempotent', () => {
  const state = { active: info('f1'), isPlaying: true };
  const next = applyListeningSessionAction(state, { kind: 'resume' });
  assert.deepEqual(next, state);
});

test('stop always returns to idle, active or not', () => {
  assert.deepEqual(
    applyListeningSessionAction({ active: info('f1'), isPlaying: true }, { kind: 'stop' }),
    IDLE_LISTENING_SESSION_STATE,
  );
  assert.deepEqual(
    applyListeningSessionAction(IDLE_LISTENING_SESSION_STATE, { kind: 'stop' }),
    IDLE_LISTENING_SESSION_STATE,
  );
});

test('a full lifecycle -- enter, pause, resume, enter a different match, stop -- transitions correctly at each step', () => {
  let state = IDLE_LISTENING_SESSION_STATE;
  state = applyListeningSessionAction(state, { kind: 'enter', matchInfo: info('f1') });
  assert.deepEqual(state, { active: info('f1'), isPlaying: true });

  state = applyListeningSessionAction(state, { kind: 'pause' });
  assert.equal(state.isPlaying, false);
  assert.equal(deriveNowListeningBarVisible(state, undefined), false);

  state = applyListeningSessionAction(state, { kind: 'resume' });
  assert.equal(state.isPlaying, true);
  assert.equal(deriveNowListeningBarVisible(state, undefined), true);

  state = applyListeningSessionAction(state, { kind: 'enter', matchInfo: info('f2') });
  assert.equal(state.active.fixtureId, 'f2');
  assert.equal(state.isPlaying, true);

  state = applyListeningSessionAction(state, { kind: 'stop' });
  assert.deepEqual(state, IDLE_LISTENING_SESSION_STATE);
});
