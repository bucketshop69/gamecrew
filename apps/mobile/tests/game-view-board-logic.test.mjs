import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBoardAccessibilityLabel,
  directionForParticipant,
  GAME_VIEW_STATE_COPY,
  pressureToIntensity,
  resolveAmbientPresence,
  selectStatePanelCopy,
  zoneToBandPosition,
  ZONE_LABELS,
} from '../src/screens/game-view/game-view-board-logic.ts';

function scene(overrides = {}) {
  return {
    id: 'scene-1',
    fixtureId: 'fx-1',
    kind: 'ambient',
    startRevision: 0,
    sourceFrameIds: ['f1'],
    durationHint: { minMs: 0, maxMs: 0 },
    ...overrides,
  };
}

function team(name, color, participant) {
  return { name, color, participant };
}

// --- directionForParticipant ---

test('directionForParticipant: participant 1 attacks the configured direction', () => {
  assert.equal(directionForParticipant(1, 'up'), 'up');
  assert.equal(directionForParticipant(1, 'down'), 'down');
});

test('directionForParticipant: participant 2 always attacks the opposite direction', () => {
  assert.equal(directionForParticipant(2, 'up'), 'down');
  assert.equal(directionForParticipant(2, 'down'), 'up');
});

test('directionForParticipant: undefined participant yields undefined direction', () => {
  assert.equal(directionForParticipant(undefined, 'up'), undefined);
});

// --- zoneToBandPosition ---

test('zoneToBandPosition: neutral zone sits at midfield regardless of direction', () => {
  assert.equal(zoneToBandPosition('neutral', 'up'), 0.5);
  assert.equal(zoneToBandPosition('neutral', 'down'), 0.5);
});

test('zoneToBandPosition: high_danger sits near the top edge when attacking up', () => {
  const position = zoneToBandPosition('high_danger', 'up');
  assert.ok(position < 0.1, `expected near-top position, got ${position}`);
});

test('zoneToBandPosition: high_danger sits near the bottom edge when attacking down', () => {
  const position = zoneToBandPosition('high_danger', 'down');
  assert.ok(position > 0.9, `expected near-bottom position, got ${position}`);
});

test('zoneToBandPosition: safe zone sits near the attacking team\'s own goal line', () => {
  const attackingUp = zoneToBandPosition('safe', 'up');
  const attackingDown = zoneToBandPosition('safe', 'down');
  assert.ok(attackingUp > 0.8, `expected safe-attacking-up near bottom, got ${attackingUp}`);
  assert.ok(attackingDown < 0.2, `expected safe-attacking-down near top, got ${attackingDown}`);
});

test('zoneToBandPosition: defaults to the neutral position for an unspecified zone', () => {
  assert.equal(zoneToBandPosition(undefined, 'up'), zoneToBandPosition('neutral', 'up'));
});

test('zoneToBandPosition: progression is monotonic toward goal as zones escalate', () => {
  const order = ['safe', 'neutral', 'attack', 'danger', 'high_danger'];
  const positions = order.map((zone) => zoneToBandPosition(zone, 'up'));
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(
      positions[index] < positions[index - 1],
      `expected zone ${order[index]} closer to goal (smaller position when attacking up) than ${order[index - 1]}`,
    );
  }
});

// --- pressureToIntensity ---

test('pressureToIntensity: escalates intensity, scale, opacity, and pulse speed with zone severity', () => {
  const low = pressureToIntensity('safe', undefined);
  const high = pressureToIntensity('high_danger', undefined);

  assert.ok(high.intensity > low.intensity);
  assert.ok(high.scale > low.scale);
  assert.ok(high.outerOpacity > low.outerOpacity);
  assert.ok(high.innerOpacity > low.innerOpacity);
  assert.ok(high.pulseDurationMs < low.pulseDurationMs, 'higher pressure should pulse faster (lower duration)');
});

test('pressureToIntensity: explicit pressure takes precedence over zone baseline', () => {
  const zoneOnly = pressureToIntensity('safe', undefined);
  const pressureOverride = pressureToIntensity('safe', 'high_danger');
  assert.ok(pressureOverride.intensity > zoneOnly.intensity);
});

test('pressureToIntensity: missing zone and pressure fall back to neutral intensity', () => {
  const fallback = pressureToIntensity(undefined, undefined);
  const neutral = pressureToIntensity('neutral', undefined);
  assert.equal(fallback.intensity, neutral.intensity);
});

test('pressureToIntensity: intensity stays within 0..1', () => {
  for (const zone of ['safe', 'neutral', 'attack', 'danger', 'high_danger']) {
    const result = pressureToIntensity(zone, undefined);
    assert.ok(result.intensity >= 0 && result.intensity <= 1);
  }
});

// --- resolveAmbientPresence ---

test('resolveAmbientPresence: returns undefined for non-ambient scenes', () => {
  const home = team('Mexico', '#00753F', 1);
  const away = team('Ecuador', '#FFD400', 2);
  const result = resolveAmbientPresence(scene({ kind: 'card', participant: 1 }), home, away);
  assert.equal(result, undefined);
});

test('resolveAmbientPresence: returns undefined when the scene has no owning participant', () => {
  const home = team('Mexico', '#00753F', 1);
  const away = team('Ecuador', '#FFD400', 2);
  const result = resolveAmbientPresence(scene({ kind: 'ambient' }), home, away);
  assert.equal(result, undefined);
});

test('resolveAmbientPresence: returns undefined for a null scene', () => {
  const home = team('Mexico', '#00753F', 1);
  const away = team('Ecuador', '#FFD400', 2);
  assert.equal(resolveAmbientPresence(null, home, away), undefined);
  assert.equal(resolveAmbientPresence(undefined, home, away), undefined);
});

test('resolveAmbientPresence: resolves the home team\'s color and name when home has possession', () => {
  const home = team('Mexico', '#00753F', 1);
  const away = team('Ecuador', '#FFD400', 2);
  const result = resolveAmbientPresence(
    scene({ kind: 'ambient', participant: 1, zone: 'danger' }),
    home,
    away,
  );

  assert.ok(result);
  assert.equal(result.color, '#00753F');
  assert.equal(result.teamName, 'Mexico');
  assert.equal(result.zoneLabel, ZONE_LABELS.danger);
});

test('resolveAmbientPresence: resolves the away team\'s color and flips direction', () => {
  const home = team('Mexico', '#00753F', 1);
  const away = team('Ecuador', '#FFD400', 2);
  const homePresence = resolveAmbientPresence(
    scene({ kind: 'ambient', participant: 1, zone: 'attack' }),
    home,
    away,
    'up',
  );
  const awayPresence = resolveAmbientPresence(
    scene({ kind: 'ambient', participant: 2, zone: 'attack' }),
    home,
    away,
    'up',
  );

  assert.ok(homePresence && awayPresence);
  assert.equal(awayPresence.color, '#FFD400');
  assert.notEqual(homePresence.direction, awayPresence.direction);
});

test('resolveAmbientPresence: prefers scene.zone over scene.pressure for position, pressure for intensity precedence', () => {
  const home = team('Mexico', '#00753F', 1);
  const away = team('Ecuador', '#FFD400', 2);
  const result = resolveAmbientPresence(
    scene({ kind: 'ambient', participant: 1, zone: 'safe', pressure: 'high_danger' }),
    home,
    away,
    'up',
  );

  assert.ok(result);
  // Position is derived from zone (falls back to pressure only if zone is absent).
  assert.equal(result.position, zoneToBandPosition('safe', 'up'));
  // Intensity explicitly prefers pressure over zone.
  assert.equal(result.intensity.intensity, pressureToIntensity('safe', 'high_danger').intensity);
});

// --- buildBoardAccessibilityLabel ---

test('buildBoardAccessibilityLabel: describes a quiet board when there is no presence', () => {
  const label = buildBoardAccessibilityLabel(undefined);
  assert.match(label, /no active possession/i);
});

test('buildBoardAccessibilityLabel: matches the "Team verb in the zone." shape from the PRD example', () => {
  const home = team('Mexico', '#00753F', 1);
  const away = team('Ecuador', '#FFD400', 2);
  const presence = resolveAmbientPresence(
    scene({ kind: 'ambient', participant: 1, zone: 'danger' }),
    home,
    away,
  );
  const label = buildBoardAccessibilityLabel(presence);
  assert.equal(label, 'Mexico pressing in the danger zone.');
});

test('buildBoardAccessibilityLabel: uses a calmer verb at low intensity', () => {
  const home = team('Mexico', '#00753F', 1);
  const away = team('Ecuador', '#FFD400', 2);
  const presence = resolveAmbientPresence(
    scene({ kind: 'ambient', participant: 1, zone: 'safe' }),
    home,
    away,
  );
  const label = buildBoardAccessibilityLabel(presence);
  assert.match(label, /in possession/);
});

// --- selectStatePanelCopy / GAME_VIEW_STATE_COPY ---

test('selectStatePanelCopy: returns undefined for ready state (board renders itself)', () => {
  assert.equal(selectStatePanelCopy('ready'), undefined);
});

test('selectStatePanelCopy: loading copy matches the PRD exactly', () => {
  assert.deepEqual(selectStatePanelCopy('loading'), { title: 'Building Game View.' });
});

test('selectStatePanelCopy: empty copy matches the PRD exactly', () => {
  assert.deepEqual(selectStatePanelCopy('empty'), {
    title: 'Game View will appear when TxLINE has enough match signal.',
  });
});

test('selectStatePanelCopy: error copy matches the PRD exactly and offers retry', () => {
  assert.deepEqual(selectStatePanelCopy('error'), {
    title: 'Game View is unavailable.',
    actionLabel: 'Retry',
  });
});

test('GAME_VIEW_STATE_COPY: stale banner copy matches the PRD exactly', () => {
  assert.deepEqual(GAME_VIEW_STATE_COPY.stale, { title: 'Waiting for the next match update.' });
});
