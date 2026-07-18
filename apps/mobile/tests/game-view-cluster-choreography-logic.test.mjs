import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attackerCountForIntensity,
  defenderCountForIntensity,
  defendingWindow,
  hashUnit,
  participantDirection,
  passIntervalMsForIntensity,
  pickSide,
  possessionWindow,
  findNearestPriorStageableScene,
  resolveClusterPlan,
  resolveClusterTransition,
  resolveHoldBootstrapPlan,
  zoneBandPosition,
  zoneIntensity,
  STICK_FIGURE_SIZE_PX,
} from '../src/screens/game-view-players/cluster-choreography-logic.ts';
import {
  directionForParticipant,
  pressureToIntensity,
  zoneToBandPosition,
} from '../src/screens/game-view/game-view-board-logic.ts';

// ---------------------------------------------------------------------------
// Mirrored-helper sync (see cluster-choreography-logic.ts header comment:
// these copies exist so the module stays importable under the plain Node
// runner; this block is what keeps them from ever drifting).
// ---------------------------------------------------------------------------

const ALL_ZONES = ['safe', 'neutral', 'attack', 'danger', 'high_danger', undefined];

test('sync: zoneBandPosition mirrors board-logic zoneToBandPosition exactly', () => {
  for (const zone of ALL_ZONES) {
    for (const direction of ['up', 'down']) {
      assert.equal(zoneBandPosition(zone, direction), zoneToBandPosition(zone, direction), `${zone}/${direction}`);
    }
  }
});

test('sync: zoneIntensity mirrors board-logic pressureToIntensity().intensity exactly', () => {
  for (const zone of ALL_ZONES) {
    for (const pressure of ALL_ZONES) {
      assert.equal(zoneIntensity(zone, pressure), pressureToIntensity(zone, pressure).intensity, `${zone}/${pressure}`);
    }
  }
});

test('sync: participantDirection mirrors board-logic directionForParticipant exactly', () => {
  for (const participant of [1, 2, undefined]) {
    for (const direction of ['up', 'down']) {
      assert.equal(participantDirection(participant, direction), directionForParticipant(participant, direction), `${participant}/${direction}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOME = { name: 'Mexico', color: '#0A6640', participant: 1 };
const AWAY = { name: 'Ecuador', color: '#FFD100', participant: 2 };

function scene(overrides = {}) {
  return {
    id: 'scene-1',
    fixtureId: 18179759,
    kind: 'ambient',
    startRevision: 1,
    sourceFrameIds: ['f1'],
    participant: 1,
    zone: 'attack',
    pressure: 'attack',
    durationHint: { minMs: 4000, maxMs: 8000 },
    ...overrides,
  };
}

function countByParticipant(figures, participant) {
  return figures.filter((figure) => figure.participant === participant).length;
}

function keeperOf(figures, participant) {
  return figures.find((figure) => figure.participant === participant && figure.role === 'keeper');
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('hashUnit: stable per seed, in [0,1)', () => {
  assert.equal(hashUnit('abc'), hashUnit('abc'));
  assert.notEqual(hashUnit('abc'), hashUnit('abd'));
  for (const seed of ['a', 'scene-42', 'x'.repeat(50)]) {
    const value = hashUnit(seed);
    assert.ok(value >= 0 && value < 1, `${seed} -> ${value}`);
  }
});

test('pickSide: deterministic left/right', () => {
  assert.equal(pickSide('goal-1'), pickSide('goal-1'));
  assert.ok(['left', 'right'].includes(pickSide('goal-1')));
});

test('resolveClusterPlan: identical scene input yields identical staging (replay determinism)', () => {
  const a = resolveClusterPlan(scene(), HOME, AWAY, 'up');
  const b = resolveClusterPlan(scene(), HOME, AWAY, 'up');
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// Formation fundamentals
// ---------------------------------------------------------------------------

test('ambient: full 22-player view -- 11 per team, one keeper each, pinned at own goal', () => {
  const plan = resolveClusterPlan(scene(), HOME, AWAY, 'up');
  assert.equal(plan.kind, 'ambient');
  assert.equal(plan.figures.length, 22);
  assert.equal(countByParticipant(plan.figures, 1), 11);
  assert.equal(countByParticipant(plan.figures, 2), 11);

  // Home attacks up -> home keeper guards the bottom edge; away keeper the top.
  const homeKeeper = keeperOf(plan.figures, 1);
  const awayKeeper = keeperOf(plan.figures, 2);
  assert.ok(homeKeeper.y > 0.9, `home keeper at own (bottom) goal, got ${homeKeeper.y}`);
  assert.ok(awayKeeper.y < 0.1, `away keeper at own (top) goal, got ${awayKeeper.y}`);
});

test('ambient: figure colors follow their team', () => {
  const plan = resolveClusterPlan(scene(), HOME, AWAY, 'up');
  for (const figure of plan.figures) {
    assert.equal(figure.color, figure.participant === 1 ? HOME.color : AWAY.color, figure.key);
  }
});

test('ambient: engaged players are foregrounded while both formation blocks recede', () => {
  const plan = resolveClusterPlan(scene({ zone: 'danger', pressure: 'danger' }), HOME, AWAY, 'up');
  assert.equal(plan.kind, 'ambient');
  const focused = plan.figures.filter((figure) => figure.focus === 'engaged');
  const formation = plan.figures.filter((figure) => figure.focus === 'formation');

  assert.ok(focused.length >= 4 && focused.length <= 5, `expected a readable action knot, got ${focused.length}`);
  assert.equal(focused.filter((figure) => figure.participant === 1).length, 3);
  assert.equal(focused.filter((figure) => figure.participant === 2).length, 1);
  assert.equal(focused.length + formation.length, plan.figures.length);
});

test('ambient: a post-red-card scene stages ten against eleven instead of restoring 22', () => {
  const plan = resolveClusterPlan(scene({
    participant: 2,
    playerCounts: { participant1: 11, participant2: 10 },
  }), HOME, AWAY, 'up');

  assert.equal(plan.kind, 'ambient');
  assert.equal(countByParticipant(plan.figures, 1), 11);
  assert.equal(countByParticipant(plan.figures, 2), 10);
  assert.equal(plan.figures.length, 21);
  assert.ok(keeperOf(plan.figures, 1));
  assert.ok(keeperOf(plan.figures, 2));
});

test('depth windows: possession block pushes up with progress, defending block sits goal-side', () => {
  // Monotonic: deeper progress -> both windows shift toward the attacked goal.
  assert.ok(possessionWindow(0.94).front > possessionWindow(0.16).front);
  assert.ok(possessionWindow(0.94).back > possessionWindow(0.16).back);
  assert.ok(defendingWindow(0.94).front < defendingWindow(0.16).front);
  for (const p of [0.16, 0.5, 0.68, 0.84, 0.94]) {
    const pw = possessionWindow(p);
    const dw = defendingWindow(p);
    assert.ok(pw.back < pw.front, `possession window ordered at ${p}`);
    assert.ok(dw.back < dw.front, `defending window ordered at ${p}`);
  }
});

test('ambient: the possession block visibly follows the true zone up the pitch', () => {
  const meanY = (plan, participant) => {
    const own = plan.figures.filter((f) => f.participant === participant && f.role !== 'keeper');
    return own.reduce((sum, f) => sum + f.y, 0) / own.length;
  };
  // Home attacks up: higher zone -> smaller mean y.
  const safe = resolveClusterPlan(scene({ zone: 'safe', pressure: 'safe' }), HOME, AWAY, 'up');
  const danger = resolveClusterPlan(scene({ zone: 'danger', pressure: 'danger' }), HOME, AWAY, 'up');
  assert.ok(meanY(danger, 1) < meanY(safe, 1), 'home block pushes up as zone rises');
  assert.ok(meanY(danger, 2) < meanY(safe, 2), 'away block gets pinned back as home advances');
});

test('ambient: same team + same zone stages identically across scene churn (no phantom movement)', () => {
  const a = resolveClusterPlan(scene({ id: 'scene-a' }), HOME, AWAY, 'up');
  const b = resolveClusterPlan(scene({ id: 'scene-b' }), HOME, AWAY, 'up');
  assert.deepEqual(
    a.figures.map(({ key, x, y }) => ({ key, x, y })),
    b.figures.map(({ key, x, y }) => ({ key, x, y })),
  );
  assert.deepEqual(a.ball, b.ball);
});

test('ambient: the ball sits with an engaged possession figure in the true zone band', () => {
  for (const zone of ['safe', 'neutral', 'attack', 'danger', 'high_danger']) {
    const plan = resolveClusterPlan(scene({ zone, pressure: zone }), HOME, AWAY, 'up');
    const anchorY = zoneToBandPosition(zone, 'up');
    assert.ok(Math.abs(plan.ball.y - Math.min(0.955, Math.max(0.045, anchorY))) < 0.15, `${zone}: ball near band`);
    const holder = plan.figures.find((figure) => figure.key === plan.ball.holderKey);
    assert.ok(holder, `${zone}: holder exists`);
    assert.equal(holder.participant, 1, `${zone}: holder is on the possessing team`);
  }
});

test('ambient: pass cycle stays within the possessing team and matches intensity', () => {
  const calm = resolveClusterPlan(scene({ zone: 'safe', pressure: 'safe' }), HOME, AWAY, 'up');
  assert.equal(calm.passCycleKeys.length, attackerCountForIntensity(zoneIntensity('safe', 'safe')));
  const hot = resolveClusterPlan(scene({ zone: 'high_danger', pressure: 'high_danger' }), HOME, AWAY, 'up');
  assert.equal(hot.passCycleKeys.length, attackerCountForIntensity(zoneIntensity('high_danger', 'high_danger')));
  for (const key of hot.passCycleKeys) {
    assert.ok(key.startsWith('p1-'), `${key} belongs to the possessing team`);
  }
  assert.ok(calm.passIntervalMs > hot.passIntervalMs, 'tempo follows real pressure');
  assert.ok(passIntervalMsForIntensity(0) > passIntervalMsForIntensity(1));
  assert.ok(defenderCountForIntensity(0.9) > defenderCountForIntensity(0.2));
});

test('ambient: no participant means the players hold in place', () => {
  const plan = resolveClusterPlan(scene({ participant: undefined }), HOME, AWAY, 'up');
  assert.equal(plan.kind, 'hold');
});

test('all figures stay inside the playable board in every plan and keyframe', () => {
  const kinds = [
    scene(),
    scene({ zone: 'high_danger', pressure: 'high_danger' }),
    scene({ kind: 'set_piece', sourceAction: 'corner' }),
    scene({ kind: 'shot', zone: 'danger' }),
    scene({ kind: 'restart' }),
    scene({ kind: 'goal_sequence', beats: [{ kind: 'tension' }] }),
  ];
  for (const sceneInput of kinds) {
    for (const direction of ['up', 'down']) {
      const plan = resolveClusterPlan(sceneInput, HOME, AWAY, direction, sceneInput.kind === 'goal_sequence' ? 'tension' : undefined);
      if (plan.kind === 'none') continue;
      const frames = plan.kind === 'ambient' ? [{ figures: plan.figures }] : plan.keyframes;
      for (const frame of frames) {
        assert.equal(frame.figures.length, 22, `${sceneInput.kind}/${direction}: full formation present`);
        for (const figure of frame.figures) {
          assert.ok(figure.x >= 0.02 && figure.x <= 0.98, `${sceneInput.kind}/${direction}: ${figure.key} x=${figure.x}`);
          assert.ok(figure.y >= 0.02 && figure.y <= 0.98, `${sceneInput.kind}/${direction}: ${figure.key} y=${figure.y}`);
        }
      }
    }
  }
});

test('staged plans fit keyframes inside the authoritative presentation window', () => {
  const durationMs = 700;
  const stagedInputs = [
    { input: scene({ kind: 'set_piece', sourceAction: 'corner', durationHint: { minMs: durationMs, maxMs: durationMs } }) },
    { input: scene({ kind: 'set_piece', sourceAction: 'throw_in', durationHint: { minMs: durationMs, maxMs: durationMs } }) },
    { input: scene({ kind: 'shot', durationHint: { minMs: durationMs, maxMs: durationMs } }) },
    {
      input: scene({ kind: 'goal_sequence', durationHint: { minMs: durationMs, maxMs: durationMs } }),
      goalBeat: 'tension',
    },
    { input: scene({ kind: 'restart', durationHint: { minMs: durationMs, maxMs: durationMs } }) },
    { input: scene({ kind: 'phase_break', phase: 'half_time', durationHint: { minMs: durationMs, maxMs: durationMs } }) },
  ];

  for (const { input, goalBeat } of stagedInputs) {
    const plan = resolveClusterPlan(input, HOME, AWAY, 'up', goalBeat);
    assert.equal(plan.kind, 'staged', input.kind);
    assert.equal(plan.durationMs, durationMs, `${input.kind} uses the engine window exactly`);
    assert.ok(
      plan.keyframes.every((frame) => frame.offsetMs >= 0 && frame.offsetMs < durationMs),
      `${input.kind} keyframes start before the window closes`,
    );
  }
});

// ---------------------------------------------------------------------------
// Corner staging
// ---------------------------------------------------------------------------

test('corner: taker at a flag of the attacked end, delivery swings into a loaded box', () => {
  const plan = resolveClusterPlan(scene({ kind: 'set_piece', sourceAction: 'corner', participant: 2 }), HOME, AWAY, 'up');
  assert.equal(plan.kind, 'staged');
  assert.equal(plan.label, 'corner');
  assert.ok(plan.keyframes.length >= 3);

  // Away (participant 2) attacks down when participant 1 attacks up.
  const setup = plan.keyframes[0];
  assert.ok(setup.ball.y > 0.85, `ball starts at the attacked (bottom) end, got y=${setup.ball.y}`);
  assert.ok(setup.ball.x < 0.1 || setup.ball.x > 0.9, `ball starts at a flag, got x=${setup.ball.x}`);
  const taker = setup.figures.find((figure) => figure.key === setup.ball.holderKey);
  assert.equal(taker.participant, 2, 'taker belongs to the attacking team');

  const swing = plan.keyframes[1];
  assert.ok(swing.ball.x > 0.3 && swing.ball.x < 0.7, 'delivery drops centrally');
  assert.ok(swing.ball.y > 0.75, 'delivery drops in the box at the attacked end');
  assert.equal(swing.figures.find((figure) => figure.key === taker.key).pose, 'strike');
  assert.ok(swing.figures.some((figure) => figure.pose === 'header'), 'someone attacks the delivery');

  // The defending keeper guards the attacked goal mouth.
  const keeper = keeperOf(setup.figures, 1);
  assert.ok(keeper.y > 0.9, `defending keeper at the attacked end, got ${keeper.y}`);
});

test('free kicks and penalties freeze the formation in place (players never leave for a dead ball)', () => {
  for (const sourceAction of ['free_kick', 'penalty', undefined]) {
    const plan = resolveClusterPlan(scene({ kind: 'set_piece', sourceAction }), HOME, AWAY, 'up');
    assert.equal(plan.kind, 'hold', `${sourceAction} should hold, not clear`);
  }
});

test('throw-in: play leans to a touchline, thrower on the line, ball thrown to a short option', () => {
  const plan = resolveClusterPlan(scene({ kind: 'set_piece', sourceAction: 'throw_in', zone: 'attack' }), HOME, AWAY, 'up');
  assert.equal(plan.kind, 'staged');
  assert.equal(plan.label, 'throw_in');

  const setup = plan.keyframes[0];
  assert.equal(setup.figures.length, 22);
  // The ball starts ON a touchline at the zone's true pitch height.
  assert.ok(setup.ball.x <= 0.06 || setup.ball.x >= 0.94, `ball on a touchline, got x=${setup.ball.x}`);
  assert.ok(Math.abs(setup.ball.y - zoneToBandPosition('attack', 'up')) < 0.06, `ball at the true band, got y=${setup.ball.y}`);
  const thrower = setup.figures.find((figure) => figure.key === setup.ball.holderKey);
  assert.equal(thrower.participant, 1, 'thrower is on the restarting team');
  assert.equal(thrower.pose, 'wall_stance', 'arms up for the throw');

  // The throw goes infield to a teammate.
  const thrown = plan.keyframes[1];
  const infield = setup.ball.x <= 0.06 ? thrown.ball.x > setup.ball.x : thrown.ball.x < setup.ball.x;
  assert.ok(infield, 'ball travels infield');

  // Both blocks lean toward the throw side versus plain ambient staging.
  const ambient = resolveClusterPlan(scene({ zone: 'attack', pressure: 'attack' }), HOME, AWAY, 'up');
  const meanX = (figures) => figures.reduce((sum, f) => sum + f.x, 0) / figures.length;
  const towardLine = setup.ball.x <= 0.06
    ? meanX(setup.figures) < meanX(ambient.figures)
    : meanX(setup.figures) > meanX(ambient.figures);
  assert.ok(towardLine, 'formations lean toward the touchline');
});

test('throw-in staging is deterministic per scene', () => {
  const input = scene({ kind: 'set_piece', sourceAction: 'throw_in', zone: 'neutral' });
  assert.deepEqual(
    resolveClusterPlan(input, HOME, AWAY, 'up'),
    resolveClusterPlan(input, HOME, AWAY, 'up'),
  );
});

// ---------------------------------------------------------------------------
// Shot staging
// ---------------------------------------------------------------------------

test('shot: strike toward the goal mouth, keeper dives, ball never crosses the line', () => {
  const plan = resolveClusterPlan(scene({ kind: 'shot', zone: 'danger', pressure: 'danger' }), HOME, AWAY, 'up');
  assert.equal(plan.kind, 'staged');
  assert.equal(plan.label, 'shot');

  const strike = plan.keyframes[1];
  assert.ok(strike.ball.y > 0.02 && strike.ball.y < 0.15, `shot toward top goal ends near it, got ${strike.ball.y}`);
  const keeper = keeperOf(strike.figures, 2);
  assert.ok(keeper.pose === 'keeper_dive_left' || keeper.pose === 'keeper_dive_right', 'keeper dives');
  const shooter = strike.figures.find((figure) => figure.key === plan.keyframes[0].ball.holderKey);
  assert.equal(shooter.pose, 'strike');
  assert.equal(shooter.participant, 1);
});

test('shot outcomes stage distinct save, miss, block, and woodwork pictures', () => {
  const onTarget = resolveClusterPlan(scene({ kind: 'shot', sourceOutcome: 'OnTarget' }), HOME, AWAY, 'up');
  const offTarget = resolveClusterPlan(scene({ kind: 'shot', sourceOutcome: 'OffTarget' }), HOME, AWAY, 'up');
  const blocked = resolveClusterPlan(scene({ kind: 'shot', sourceOutcome: 'Blocked' }), HOME, AWAY, 'up');
  const woodwork = resolveClusterPlan(scene({ kind: 'shot', sourceOutcome: 'Woodwork' }), HOME, AWAY, 'up');

  assert.equal(onTarget.label, 'shot_on_target');
  assert.equal(offTarget.label, 'shot_off_target');
  assert.equal(blocked.label, 'shot_blocked');
  assert.equal(woodwork.label, 'shot_woodwork');

  const offTargetKeeper = keeperOf(offTarget.keyframes[1].figures, 2);
  const blockedKeeper = keeperOf(blocked.keyframes[1].figures, 2);
  assert.equal(offTargetKeeper.pose, 'idle', 'a miss must not be illustrated as a save');
  assert.equal(blockedKeeper.pose, 'idle', 'a block must happen before the keeper');
  assert.ok(
    offTarget.keyframes[1].ball.x < 0.38 || offTarget.keyframes[1].ball.x > 0.62,
    'a miss finishes outside the goal mouth',
  );
});

test('goal kick: keeper restarts from the six-yard area to a grounded teammate', () => {
  const plan = resolveClusterPlan(scene({ kind: 'set_piece', sourceAction: 'goal_kick', participant: 2, zone: 'safe' }), HOME, AWAY, 'up');
  assert.equal(plan.kind, 'staged');
  assert.equal(plan.label, 'goal_kick');
  const setup = plan.keyframes[0];
  const release = plan.keyframes[1];
  assert.equal(setup.ball.holderKey, 'p2-gk');
  assert.ok(release.ball.holderKey?.startsWith('p2-'));
  assert.notEqual(release.ball.holderKey, setup.ball.holderKey);
});

// ---------------------------------------------------------------------------
// Goal celebration + kickoff
// ---------------------------------------------------------------------------

test('goal tension beat: scorers sprint to a corner flag and celebrate while the rest hold', () => {
  const goalScene = scene({
    kind: 'goal_sequence',
    beats: [{ kind: 'tension' }, { kind: 'celebration' }],
  });
  const plan = resolveClusterPlan(goalScene, HOME, AWAY, 'up', 'tension');
  assert.equal(plan.kind, 'staged');
  assert.equal(plan.label, 'goal_celebration');

  const gather = plan.keyframes[plan.keyframes.length - 1];
  const celebrating = gather.figures.filter((figure) => figure.pose === 'celebrate');
  assert.ok(celebrating.length >= 2, 'the scorers gather celebrating');
  for (const figure of celebrating) {
    assert.equal(figure.participant, 1, 'celebrants belong to the scoring team');
    assert.ok(figure.x < 0.25 || figure.x > 0.75, `celebration gathers at a flag, got x=${figure.x}`);
  }
  // The beaten side is still on the pitch, holding shape.
  assert.equal(countByParticipant(gather.figures, 2), 11);
  // Every keyframe keeps the same ball spot: the goal already happened.
  for (const frame of plan.keyframes) {
    assert.equal(frame.ball.x, plan.keyframes[0].ball.x);
    assert.equal(frame.ball.y, plan.keyframes[0].ball.y);
  }
});

test('goal celebration beat: figures hold beneath the confirmation takeover', () => {
  const goalScene = scene({ kind: 'goal_sequence', beats: [{ kind: 'tension' }, { kind: 'celebration' }] });
  assert.equal(resolveClusterPlan(goalScene, HOME, AWAY, 'up', 'celebration').kind, 'hold');
  assert.equal(resolveClusterPlan(goalScene, HOME, AWAY, 'up', undefined).kind, 'hold');
});

test('kickoff: both full elevens in their own halves, ball on the spot', () => {
  const plan = resolveClusterPlan(scene({ kind: 'restart' }), HOME, AWAY, 'up');
  assert.equal(plan.kind, 'staged');
  assert.equal(plan.label, 'kickoff');
  const frame = plan.keyframes[0];
  assert.equal(frame.ball.x, 0.5);
  assert.equal(frame.ball.y, 0.5);
  assert.equal(frame.figures.length, 22);

  // Participant 1 attacks up -> own half is the bottom (y > 0.5); participant 2 mirrors.
  for (const figure of frame.figures) {
    if (figure.participant === 1) assert.ok(figure.y > 0.5, `${figure.key} in own half, got ${figure.y}`);
    else assert.ok(figure.y < 0.5, `${figure.key} in own half, got ${figure.y}`);
  }
});

// ---------------------------------------------------------------------------
// Phase breaks: the break IS the picture
// ---------------------------------------------------------------------------

test('phase break into a half: both elevens assemble into the kickoff lineup', () => {
  for (const phase of ['pre_match', 'first_half_ready', 'first_half', 'second_half_ready', 'second_half']) {
    const plan = resolveClusterPlan(scene({ kind: 'phase_break', phase }), HOME, AWAY, 'up');
    assert.equal(plan.kind, 'staged', phase);
    assert.equal(plan.label, 'kickoff', phase);
    assert.equal(plan.keyframes[0].figures.length, 22, phase);
  }
});

test('phase break at half/full time: both teams walk off to their touchline benches', () => {
  for (const phase of ['half_time', 'full_time_pending', 'finalised']) {
    const plan = resolveClusterPlan(scene({ kind: 'phase_break', phase }), HOME, AWAY, 'up');
    assert.equal(plan.kind, 'staged', phase);
    assert.equal(plan.label, 'walk_off', phase);
    const frame = plan.keyframes[0];
    assert.equal(frame.figures.length, 22, phase);
    for (const figure of frame.figures) {
      // Home gathers at the left touchline, away at the right.
      if (figure.participant === 1) assert.ok(figure.x < 0.2, `${phase}: ${figure.key} at home bench, got x=${figure.x}`);
      else assert.ok(figure.x > 0.8, `${phase}: ${figure.key} at away bench, got x=${figure.x}`);
    }
    assert.equal(frame.ball.x, 0.5);
    assert.equal(frame.ball.y, 0.5);
  }
});

test('phase break with an unknown phase holds in place', () => {
  assert.equal(resolveClusterPlan(scene({ kind: 'phase_break', phase: undefined }), HOME, AWAY, 'up').kind, 'hold');
});

// ---------------------------------------------------------------------------
// Off scenes + transitions
// ---------------------------------------------------------------------------

test('stoppage scenes hold the players in place; only a missing scene clears the board', () => {
  for (const kind of ['card', 'var_review', 'goal_retracted', 'phase_break', 'substitution']) {
    assert.equal(resolveClusterPlan(scene({ kind }), HOME, AWAY, 'up').kind, 'hold', kind);
  }
  assert.equal(resolveClusterPlan(null, HOME, AWAY, 'up').kind, 'none');
});

test('cold stoppage bootstrap selects the nearest prior scene whose resolved plan has 22 figures', () => {
  const grounded = scene({ id: 'grounded', kind: 'ambient', participant: 1, zone: 'danger' });
  const malformedAmbient = scene({ id: 'no-owner', kind: 'ambient', participant: undefined });
  const earlierHold = scene({ id: 'earlier-card', kind: 'card' });
  const current = scene({ id: 'current-var', kind: 'var_review' });

  const selected = findNearestPriorStageableScene(
    [grounded, malformedAmbient, earlierHold, current],
    current,
    HOME,
    AWAY,
    'up',
  );

  assert.equal(selected?.id, grounded.id);
});

test('cold stoppage bootstrap does not borrow a scene when current is absent from the timeline', () => {
  const grounded = scene({ id: 'grounded' });
  const current = scene({ id: 'not-in-timeline', kind: 'card' });
  assert.equal(
    findNearestPriorStageableScene([grounded], current, HOME, AWAY, 'up'),
    undefined,
  );
});

test('grounded stoppage bootstrap freezes the prior final frame with its ball location', () => {
  const seed = scene({ id: 'seed-shot', kind: 'shot', participant: 1, zone: 'danger' });
  const sourcePlan = resolveClusterPlan(seed, HOME, AWAY, 'up');
  assert.equal(sourcePlan.kind, 'staged');
  const sourceFrame = sourcePlan.keyframes[sourcePlan.keyframes.length - 1];

  const bootstrap = resolveHoldBootstrapPlan(seed, HOME, AWAY, 'up');
  assert.equal(bootstrap.source, 'prior_scene');
  assert.equal(bootstrap.figures.length, 22);
  assert.equal(bootstrap.ball.visible, true);
  assert.equal(bootstrap.ball.x, sourceFrame.ball.x);
  assert.equal(bootstrap.ball.y, sourceFrame.ball.y);
  assert.ok(bootstrap.figures.every((figure) => figure.pose === 'idle'));
});

test('ungrounded stoppage bootstrap uses neutral 11-v-11 formations and hides the ball', () => {
  const bootstrap = resolveHoldBootstrapPlan(undefined, HOME, AWAY, 'up');
  assert.equal(bootstrap.source, 'neutral');
  assert.equal(bootstrap.figures.length, 22);
  assert.equal(countByParticipant(bootstrap.figures, 1), 11);
  assert.equal(countByParticipant(bootstrap.figures, 2), 11);
  assert.equal(bootstrap.ball.visible, false);
  assert.equal(bootstrap.ball.holderKey, undefined);
  assert.ok(bootstrap.figures.every((figure) => (
    figure.x >= 0 && figure.x <= 1 && figure.y >= 0 && figure.y <= 1
  )));
});

test('transitions: same team flows, possession flip is a turnover, everything else cuts', () => {
  const homeAmbient = scene({ id: 'a1', participant: 1 });
  const homeAmbient2 = scene({ id: 'a2', participant: 1, zone: 'danger' });
  const awayAmbient = scene({ id: 'a3', participant: 2 });
  const homeShot = scene({ id: 's1', kind: 'shot', participant: 1 });
  const card = scene({ id: 'c1', kind: 'card', participant: 1 });

  assert.equal(resolveClusterTransition(homeAmbient, homeAmbient2), 'flow');
  assert.equal(resolveClusterTransition(homeAmbient, homeShot), 'flow');
  assert.equal(resolveClusterTransition(homeAmbient, awayAmbient), 'turnover');
  assert.equal(resolveClusterTransition(homeAmbient, card), 'cut');
  assert.equal(resolveClusterTransition(card, homeAmbient), 'cut');
  assert.equal(resolveClusterTransition(null, homeAmbient), 'cut');
});

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

test('stickman figure size is set for the approved mockup look', () => {
  assert.ok(STICK_FIGURE_SIZE_PX >= 16 && STICK_FIGURE_SIZE_PX <= 26);
});
