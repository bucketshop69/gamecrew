import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GAME_VIEW_COMMENTARY_LINE_LIMIT,
  isGameViewCommentaryProjectionCompatible,
  selectVisibleGameViewCommentary,
} from '../src/screens/game-view/game-view-commentary-logic.ts';

function scene(sequence, overrides = {}) {
  return {
    id: `scene-${sequence}`,
    fixtureId: 'fixture-1',
    kind: 'ambient',
    startRevision: sequence,
    sourceFrameIds: [`fixture-1:${sequence}`],
    sourceCueIds: [`cue-${sequence}`],
    durationHint: { minMs: 0, maxMs: 0 },
    ...overrides,
  };
}

function commentary(sequence, overrides = {}) {
  return {
    id: `commentary-${sequence}`,
    fixtureId: 'fixture-1',
    batchId: `batch-${sequence}`,
    fromSeq: sequence,
    toSeq: sequence,
    sortSeq: sequence,
    period: 'first_half',
    clock: { seconds: sequence, minute: 1, label: `1'` },
    kind: 'commentary',
    sourceEvents: [],
    sourceFrameIds: [`fixture-1:${sequence}`],
    cueIds: [`cue-${sequence}`],
    commentary: `Line ${sequence}`,
    intensity: 'quiet',
    momentumSide: 'neutral',
    confidence: 'high',
    generation: 'source',
    fallbackCommentary: `Line ${sequence}`,
    enrichmentStatus: 'complete',
    ...overrides,
  };
}

test('commentary stays empty until Game View has an active source scene', () => {
  assert.deepEqual(selectVisibleGameViewCommentary([commentary(1)], [], -1), []);
  assert.deepEqual(selectVisibleGameViewCommentary([commentary(1)], [scene(1)], -1), []);
});

test('shows the current entry plus the two prior entries in chronological display order', () => {
  const timeline = [1, 2, 3, 4, 5, 6].map((sequence) => scene(sequence));
  const entriesNewestFirst = [6, 5, 4, 3, 2, 1].map((sequence) => commentary(sequence));

  const visible = selectVisibleGameViewCommentary(entriesNewestFirst, timeline, 4);

  assert.equal(visible.length, GAME_VIEW_COMMENTARY_LINE_LIMIT);
  assert.deepEqual(visible.map((entry) => entry.sortSeq), [3, 4, 5]);
});

test('never shows commentary from a future source sequence', () => {
  const visible = selectVisibleGameViewCommentary(
    [commentary(20), commentary(10)],
    [scene(10), scene(15)],
    1,
  );

  assert.deepEqual(visible.map((entry) => entry.sortSeq), [10]);
});

test('uses the greatest source frame sequence as a multi-frame entry activation point', () => {
  const multiFrameEntry = commentary(10, {
    sourceFrameIds: ['fixture-1:10', 'fixture-1:12'],
  });
  const timeline = [scene(10), scene(11), scene(12)];

  assert.deepEqual(selectVisibleGameViewCommentary([multiFrameEntry], timeline, 1), []);
  assert.deepEqual(selectVisibleGameViewCommentary([multiFrameEntry], timeline, 2), [multiFrameEntry]);
});

test('an immediate confirmed caption appears on the same merged lifecycle scene', () => {
  const confirmedCaption = commentary(11, {
    sourceFrameIds: ['fixture-1:11'],
    commentary: 'Corner to Team B.',
  });
  const mergedCornerScene = scene(10, {
    kind: 'set_piece',
    sourceAction: 'corner',
    sourceFrameIds: ['fixture-1:10', 'fixture-1:11'],
  });

  assert.deepEqual(
    selectVisibleGameViewCommentary([confirmedCaption], [mergedCornerScene], 0),
    [confirmedCaption],
  );
});

test('same-frame captions activate on their cue-aligned scenes instead of appearing together', () => {
  const card = commentary(10, {
    id: 'commentary-card',
    cueIds: ['cue-card'],
    kind: 'card',
    commentary: 'A yellow card is shown.',
  });
  const corner = commentary(10, {
    id: 'commentary-corner',
    cueIds: ['cue-corner'],
    kind: 'corner',
    commentary: 'Corner to Team B.',
  });
  const timeline = [
    scene(10, { id: 'scene-card', kind: 'card', sourceCueIds: ['cue-card'] }),
    scene(10, {
      id: 'scene-corner',
      kind: 'set_piece',
      sourceAction: 'corner',
      sourceCueIds: ['cue-corner'],
    }),
  ];

  assert.deepEqual(
    selectVisibleGameViewCommentary([corner, card], timeline, 0),
    [card],
  );
  assert.deepEqual(
    selectVisibleGameViewCommentary([corner, card], timeline, 1),
    [card, corner],
  );
});

test('same-frame possession copy waits for its ambient scene after a set piece', () => {
  const setPiece = commentary(12, {
    id: 'commentary-throw-in',
    cueIds: ['cue-throw-in'],
    kind: 'set_piece',
    commentary: 'Throw-in to Team A.',
  });
  const possession = commentary(12, {
    id: 'commentary-possession',
    cueIds: ['cue-possession'],
    commentary: 'Team A take possession.',
  });
  const timeline = [
    scene(12, {
      id: 'scene-throw-in',
      kind: 'set_piece',
      sourceAction: 'throw_in',
      sourceCueIds: ['cue-throw-in'],
    }),
    scene(12, {
      id: 'scene-possession',
      kind: 'ambient',
      sourceCueIds: ['cue-possession'],
    }),
  ];

  assert.deepEqual(
    selectVisibleGameViewCommentary([possession, setPiece], timeline, 0),
    [setPiece],
  );
  assert.deepEqual(
    selectVisibleGameViewCommentary([possession, setPiece], timeline, 1),
    [setPiece, possession],
  );
});

test('falls back to durable entry sequences when source frame ids are unavailable', () => {
  const entry = commentary(8, { sourceFrameIds: undefined, toSeq: 9 });
  const visible = selectVisibleGameViewCommentary([entry], [scene(8), scene(9)], 1);

  assert.deepEqual(visible, [entry]);
});

test('a delayed clock/source correction does not remove commentary already reached', () => {
  const timeline = [scene(10), scene(8)];
  const visible = selectVisibleGameViewCommentary([commentary(10)], timeline, 1);

  assert.deepEqual(visible.map((entry) => entry.sortSeq), [10]);
});

test('confirmed goal copy waits for celebration and cannot spoil the checking beat', () => {
  const prior = commentary(18);
  const goal = commentary(20, {
    kind: 'goal',
    sourceFrameIds: ['fixture-1:20', 'fixture-1:22'],
    commentary: 'Goal confirmed. 1-0.',
  });
  const goalScene = scene(20, {
    kind: 'goal_sequence',
    sourceFrameIds: ['fixture-1:20', 'fixture-1:22'],
    beats: [
      { kind: 'tension', lifecycle: 'provisional', sourceFrameIds: ['fixture-1:20'] },
      { kind: 'celebration', lifecycle: 'confirmed', sourceFrameIds: ['fixture-1:20', 'fixture-1:22'] },
    ],
  });
  const timeline = [scene(18), goalScene];

  assert.deepEqual(
    selectVisibleGameViewCommentary([goal, prior], timeline, 1, goalScene.beats[0]),
    [prior],
  );
  assert.deepEqual(
    selectVisibleGameViewCommentary([goal, prior], timeline, 1, goalScene.beats[1]),
    [prior, goal],
  );
});

test('the active goal beat cursor cannot reveal unrelated future copy merged into the scene', () => {
  const checking = commentary(21, { commentary: 'Still checking.' });
  const future = commentary(22, { commentary: 'Decision complete.' });
  const goalScene = scene(20, {
    kind: 'goal_sequence',
    sourceFrameIds: ['fixture-1:20', 'fixture-1:22'],
  });
  const tensionBeat = {
    kind: 'tension',
    lifecycle: 'provisional',
    sourceFrameIds: ['fixture-1:20'],
  };

  assert.deepEqual(
    selectVisibleGameViewCommentary([future, checking], [goalScene], 0, tensionBeat),
    [],
  );
});

test('commentary projection must match playback unless the legacy payload has no generation', () => {
  assert.equal(isGameViewCommentaryProjectionCompatible(2, 2), true);
  assert.equal(isGameViewCommentaryProjectionCompatible(undefined, 2), true);
  assert.equal(isGameViewCommentaryProjectionCompatible(1, 2), false);
});
