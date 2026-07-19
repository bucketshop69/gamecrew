import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBoardAccessibilityLabel,
  directionForParticipant,
  GAME_VIEW_STATE_COPY,
  PITCH_MARKINGS,
  pressureToIntensity,
  resolveAmbientPresence,
  resolveBoardPresence,
  resolveCenteredBoxLayout,
  resolveGoalEndTeams,
  resolveHeldPresence,
  selectStatePanelCopy,
  zoneLabelForDirection,
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

test('selectStatePanelCopy: empty copy names no internal system (fix round item 4)', () => {
  assert.deepEqual(selectStatePanelCopy('empty'), {
    title: 'Game View opens when the match starts.',
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

// --- pressureToIntensity: visibility floor (fix #5) ---

test('pressureToIntensity: safe (lowest) zone still clears the visibility floor', () => {
  const lowest = pressureToIntensity('safe', undefined);
  assert.ok(lowest.outerOpacity >= 0.32, `expected outerOpacity floor, got ${lowest.outerOpacity}`);
  assert.ok(lowest.innerOpacity >= 0.55, `expected innerOpacity floor, got ${lowest.innerOpacity}`);
  assert.ok(lowest.scale >= 1.08, `expected scale floor, got ${lowest.scale}`);
});

test('pressureToIntensity: the floor does not clip the high end of the gradient', () => {
  const low = pressureToIntensity('safe', undefined);
  const high = pressureToIntensity('high_danger', undefined);
  assert.ok(high.outerOpacity > low.outerOpacity);
  assert.ok(high.innerOpacity > low.innerOpacity);
  assert.ok(high.scale > low.scale);
});

// --- resolveGoalEndTeams (fix #1, revised to a language-free color affordance) ---

test('resolveGoalEndTeams: participant 1 attacking up puts participant 2\'s (away) goal at the top', () => {
  const home = { name: 'Mexico', color: '#0A6640' };
  const away = { name: 'Ecuador', color: '#FFD100' };
  const ends = resolveGoalEndTeams(home, away, 'up');
  assert.equal(ends.top, away);
  assert.equal(ends.bottom, home);
});

test('resolveGoalEndTeams: flips when participant 1 attacks down', () => {
  const home = { name: 'Mexico', color: '#0A6640' };
  const away = { name: 'Ecuador', color: '#FFD100' };
  const ends = resolveGoalEndTeams(home, away, 'down');
  assert.equal(ends.top, home);
  assert.equal(ends.bottom, away);
});

// --- zoneLabelForDirection (fix #1) ---

test('zoneLabelForDirection: midfield reads the same regardless of direction', () => {
  assert.equal(zoneLabelForDirection('neutral', 'up'), zoneLabelForDirection('neutral', 'down'));
});

test('zoneLabelForDirection: danger/attack point toward the edge they advance toward', () => {
  assert.match(zoneLabelForDirection('danger', 'up'), /↑/);
  assert.match(zoneLabelForDirection('danger', 'down'), /↓/);
  assert.match(zoneLabelForDirection('attack', 'up'), /↑/);
  assert.match(zoneLabelForDirection('attack', 'down'), /↓/);
});

test('zoneLabelForDirection: high_danger shares danger\'s direction-relative label', () => {
  assert.equal(zoneLabelForDirection('high_danger', 'up'), zoneLabelForDirection('danger', 'up'));
});

// --- resolveHeldPresence / resolveBoardPresence (fix #4) ---

test('resolveHeldPresence: with no prior presence, centers a neutral placement at midfield', () => {
  const held = resolveHeldPresence(undefined);
  assert.equal(held.isHeld, true);
  assert.equal(held.position, zoneToBandPosition('neutral', 'up'));
  assert.equal(held.zoneLabel, ZONE_LABELS.neutral);
});

test('resolveHeldPresence: carries forward a prior presence, dimmed and marked held', () => {
  const home = team('Mexico', '#00753F', 1);
  const away = team('Ecuador', '#FFD400', 2);
  const live = resolveAmbientPresence(
    scene({ kind: 'ambient', participant: 1, zone: 'danger' }),
    home,
    away,
  );
  const held = resolveHeldPresence(live);

  assert.equal(held.isHeld, true);
  assert.equal(held.teamName, 'Mexico');
  assert.equal(held.color, '#00753F');
  assert.equal(held.position, live.position);
});

test('resolveHeldPresence: dimmed opacity is lower than the live visibility floor', () => {
  const home = team('Mexico', '#00753F', 1);
  const away = team('Ecuador', '#FFD400', 2);
  const live = resolveAmbientPresence(
    scene({ kind: 'ambient', participant: 1, zone: 'safe' }),
    home,
    away,
  );
  const held = resolveHeldPresence(live);
  assert.ok(held.intensity.outerOpacity < live.intensity.outerOpacity);
});

test('resolveBoardPresence: returns the live presence directly when the scene has one', () => {
  const home = team('Mexico', '#00753F', 1);
  const away = team('Ecuador', '#FFD400', 2);
  const result = resolveBoardPresence(
    scene({ kind: 'ambient', participant: 1, zone: 'attack' }),
    home,
    away,
    undefined,
  );
  assert.equal(result.isHeld, false);
  assert.equal(result.teamName, 'Mexico');
});

test('resolveBoardPresence: carries the last live presence forward for a scene with none (fix #4)', () => {
  const home = team('Mexico', '#00753F', 1);
  const away = team('Ecuador', '#FFD400', 2);
  const lastLive = resolveAmbientPresence(
    scene({ kind: 'ambient', participant: 2, zone: 'danger' }),
    home,
    away,
  );
  // A takeover scene (e.g. a minor set-piece badge scene) carries no ambient
  // possession presence of its own.
  const result = resolveBoardPresence(
    scene({ kind: 'set_piece', participant: 1 }),
    home,
    away,
    lastLive,
  );
  assert.equal(result.isHeld, true);
  assert.equal(result.teamName, 'Ecuador');
  assert.equal(result.position, lastLive.position);
});

test('resolveBoardPresence: falls back to the neutral placement when there is no scene and no prior presence', () => {
  const home = team('Mexico', '#00753F', 1);
  const away = team('Ecuador', '#FFD400', 2);
  const result = resolveBoardPresence(null, home, away, undefined);
  assert.equal(result.isHeld, true);
  assert.equal(result.position, zoneToBandPosition('neutral', 'up'));
});

// --- buildBoardAccessibilityLabel: held presence (fix #4) ---

test('buildBoardAccessibilityLabel: describes a neutral held presence as waiting for kickoff', () => {
  const held = resolveHeldPresence(undefined);
  const label = buildBoardAccessibilityLabel(held);
  assert.match(label, /kickoff/i);
});

test('buildBoardAccessibilityLabel: describes a carried presence as last known play', () => {
  const home = team('Mexico', '#00753F', 1);
  const away = team('Ecuador', '#FFD400', 2);
  const live = resolveAmbientPresence(
    scene({ kind: 'ambient', participant: 1, zone: 'danger' }),
    home,
    away,
  );
  const held = resolveHeldPresence(live);
  const label = buildBoardAccessibilityLabel(held);
  assert.match(label, /last known play/i);
  assert.match(label, /Mexico/);
});

// --- resolveCenteredBoxLayout / PITCH_MARKINGS (R1 pitch markings) ---

test('resolveCenteredBoxLayout: centers the box so left inset + width + left inset == 100', () => {
  const layout = resolveCenteredBoxLayout(PITCH_MARKINGS.penaltyBox);
  assert.equal(layout.leftPct + layout.widthPct + layout.leftPct, 100);
});

test('resolveCenteredBoxLayout: penalty box resolves to the documented ~60% width', () => {
  const layout = resolveCenteredBoxLayout(PITCH_MARKINGS.penaltyBox);
  assert.equal(layout.widthPct, 60);
  assert.equal(layout.leftPct, 20);
  assert.ok(Math.abs(layout.depthPct - 17) < 0.001);
});

test('resolveCenteredBoxLayout: six-yard box resolves to the documented ~30% width', () => {
  const layout = resolveCenteredBoxLayout(PITCH_MARKINGS.sixYardBox);
  assert.equal(layout.widthPct, 30);
  assert.equal(layout.leftPct, 35);
});

test('resolveCenteredBoxLayout: six-yard box is narrower and shallower than the penalty box', () => {
  const penaltyBox = resolveCenteredBoxLayout(PITCH_MARKINGS.penaltyBox);
  const sixYardBox = resolveCenteredBoxLayout(PITCH_MARKINGS.sixYardBox);
  assert.ok(sixYardBox.widthPct < penaltyBox.widthPct);
  assert.ok(sixYardBox.depthPct < penaltyBox.depthPct);
  // Six-yard box must nest fully inside the penalty box's horizontal span.
  assert.ok(sixYardBox.leftPct > penaltyBox.leftPct);
});

test('resolveCenteredBoxLayout: goal mouth is narrower than the six-yard box and nests inside it', () => {
  const sixYardBox = resolveCenteredBoxLayout(PITCH_MARKINGS.sixYardBox);
  const goalMouth = resolveCenteredBoxLayout(PITCH_MARKINGS.goalMouth);
  assert.ok(goalMouth.widthPct < sixYardBox.widthPct);
  assert.ok(goalMouth.leftPct > sixYardBox.leftPct);
});

test('resolveCenteredBoxLayout: an arbitrary width/depth pair centers correctly', () => {
  const layout = resolveCenteredBoxLayout({ widthPct: 0.5, depthPct: 0.25 });
  assert.equal(layout.widthPct, 50);
  assert.equal(layout.leftPct, 25);
  assert.equal(layout.depthPct, 25);
});
