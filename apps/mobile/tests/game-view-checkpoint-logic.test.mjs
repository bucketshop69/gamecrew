import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGameViewCheckpointRail,
  findActiveGameViewCheckpointId,
  findGameViewCheckpointCommentaryEntryId,
  resolveGameViewCheckpointReplayStartIndex,
} from '../src/screens/game-view/game-view-checkpoint-logic.ts';

function scene(kind, clockSeconds, overrides = {}) {
  const index = overrides.startRevision ?? clockSeconds ?? 0;
  return {
    id: `${kind}-${index}`,
    fixtureId: 'fixture-1',
    kind,
    startRevision: index,
    sourceFrameIds: [`frame-${index}`],
    sourceCueIds: [`cue-${index}`],
    clockSeconds,
    durationHint: { minMs: 1_000, maxMs: 2_000 },
    ...overrides,
  };
}

test('buildGameViewCheckpointRail keeps only source-grounded critical moments', () => {
  const timeline = [
    scene('ambient', 0),
    scene('goal_sequence', 600, { lifecycle: 'provisional' }),
    scene('goal_sequence', 720, {
      lifecycle: 'confirmed',
      participant: 1,
      beats: [{ kind: 'celebration', lifecycle: 'confirmed', sourceFrameIds: ['goal-frame'] }],
    }),
    scene('card', 1_200, { lifecycle: 'confirmed', sourceAction: 'yellow_card' }),
    scene('card', 1_800, { lifecycle: 'confirmed', sourceAction: 'red_card', participant: 2 }),
    scene('set_piece', 2_700, { lifecycle: 'observed', sourceAction: 'penalty', participant: 1 }),
    scene('var_review', 3_000, { lifecycle: 'provisional', sourceType: 'PenaltyReview' }),
    scene('goal_retracted', 3_120, { lifecycle: 'retracted', participant: 2 }),
    scene('card', 3_300, { lifecycle: 'retracted', sourceAction: 'red_card' }),
    scene('goal_sequence', undefined, { lifecycle: 'confirmed' }),
  ];

  const rail = buildGameViewCheckpointRail(timeline);

  assert.equal(rail.durationSeconds, 90 * 60);
  assert.equal(rail.endLabel, "90′");
  assert.deepEqual(
    rail.checkpoints.map(({ kind, sceneIndex, minute, participant }) => ({ kind, sceneIndex, minute, participant })),
    [
      { kind: 'goal', sceneIndex: 2, minute: 12, participant: 1 },
      { kind: 'red_card', sceneIndex: 4, minute: 30, participant: 2 },
      { kind: 'penalty', sceneIndex: 5, minute: 45, participant: 1 },
      { kind: 'var', sceneIndex: 6, minute: 50, participant: undefined },
      { kind: 'overturned_goal', sceneIndex: 7, minute: 52, participant: 2 },
    ],
  );
  assert.equal(rail.checkpoints[0].position, 720 / (90 * 60));
  assert.equal(rail.checkpoints[4].accessibilityLabel, "Jump to overturned goal at 52′");
});

test('the full-height scale grows to the source-recorded finish instead of clipping stoppage or extra time', () => {
  const rail = buildGameViewCheckpointRail([
    scene('goal_sequence', 60, { lifecycle: 'confirmed' }),
    scene('phase_break', 5_760, { sourceAction: 'full_time' }),
  ]);

  assert.equal(rail.durationSeconds, 5_760);
  assert.equal(rail.endLabel, "96′");
  assert.equal(rail.checkpoints[0].position, 60 / 5_760);
});

test('explicit source classifications cover straight reds, second-yellow dismissals, and penalties', () => {
  const rail = buildGameViewCheckpointRail([
    scene('card', 600, { lifecycle: 'confirmed', sourceType: 'StraightRed' }),
    scene('card', 1_200, { lifecycle: 'confirmed', sourceType: 'SecondYellowRed' }),
    scene('set_piece', 1_800, { lifecycle: 'confirmed', sourceType: 'Penalty' }),
  ]);

  assert.deepEqual(rail.checkpoints.map((checkpoint) => checkpoint.kind), [
    'red_card',
    'red_card',
    'penalty',
  ]);
});

test('near-simultaneous critical moments receive separate compact lanes on the narrow rail', () => {
  const rail = buildGameViewCheckpointRail([
    scene('set_piece', 3_600, { lifecycle: 'confirmed', sourceAction: 'penalty' }),
    scene('var_review', 3_610, { lifecycle: 'confirmed' }),
    scene('goal_sequence', 3_620, { lifecycle: 'confirmed' }),
    scene('card', 4_200, { lifecycle: 'confirmed', sourceAction: 'red_card' }),
  ]);

  assert.deepEqual(rail.checkpoints.map((checkpoint) => checkpoint.lane), [0, 1, 2, 0]);
});

test('findActiveGameViewCheckpointId follows the latest checkpoint reached by the canonical playhead', () => {
  const checkpoints = buildGameViewCheckpointRail([
    scene('ambient', 0),
    scene('goal_sequence', 600, { lifecycle: 'confirmed' }),
    scene('ambient', 900),
    scene('card', 1_200, { lifecycle: 'confirmed', sourceAction: 'red_card' }),
    scene('ambient', 1_500),
  ]).checkpoints;

  assert.equal(findActiveGameViewCheckpointId(checkpoints, 0), undefined);
  assert.equal(findActiveGameViewCheckpointId(checkpoints, 2), checkpoints[0].id);
  assert.equal(findActiveGameViewCheckpointId(checkpoints, 4), checkpoints[1].id);
});

test('checkpoint replay begins two canonical scenes before the moment and clamps at kickoff', () => {
  assert.equal(resolveGameViewCheckpointReplayStartIndex(20), 18);
  assert.equal(resolveGameViewCheckpointReplayStartIndex(2), 0);
  assert.equal(resolveGameViewCheckpointReplayStartIndex(1), 0);
  assert.equal(resolveGameViewCheckpointReplayStartIndex(0), 0);
});

test('checkpoint commentary mapping does not confuse goals that share a score cue', () => {
  const timeline = [
    scene('goal_sequence', 3_300, {
      lifecycle: 'confirmed',
      sourceCueIds: ['cue:goal:gordon', 'cue:score'],
      sourceFrameIds: ['frame:goal:gordon', 'frame:score:gordon'],
    }),
  ];
  const entries = [
    {
      id: 'commentary:later-goal',
      cueIds: ['cue:goal:martinez', 'cue:score'],
      sourceFrameIds: ['frame:goal:martinez'],
    },
    {
      id: 'commentary:gordon-goal',
      cueIds: ['cue:goal:gordon', 'cue:score'],
      sourceFrameIds: ['frame:goal:gordon'],
    },
  ];

  assert.equal(
    findGameViewCheckpointCommentaryEntryId(timeline, 0, entries),
    'commentary:gordon-goal',
  );
});

test('checkpoint commentary mapping prefers the strongest cue overlap when frame provenance is absent', () => {
  const timeline = [
    scene('goal_sequence', 3_300, {
      lifecycle: 'confirmed',
      sourceCueIds: ['cue:goal:gordon', 'cue:score'],
      sourceFrameIds: [],
    }),
  ];
  const entries = [
    { id: 'commentary:shared-score-only', cueIds: ['cue:score'] },
    { id: 'commentary:gordon-goal', cueIds: ['cue:goal:gordon', 'cue:score'] },
  ];

  assert.equal(
    findGameViewCheckpointCommentaryEntryId(timeline, 0, entries),
    'commentary:gordon-goal',
  );
});
