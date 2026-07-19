import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGameViewCheckpointRail,
  buildGameViewHighlightsSequence,
  buildGameViewScorerRows,
  buildGameViewScorerTimeline,
  findActiveGameViewCheckpointId,
  findGameViewCheckpointCommentaryEntryId,
  parseGoalScorerName,
  resolveGameViewCheckpointClipWindow,
  resolveGameViewCheckpointReplayStartIndex,
  resolveGameViewHighlightsAdvance,
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

// ---------------------------------------------------------------------------
// Clip window resolution (item 8)
// ---------------------------------------------------------------------------

/** Builds a dense one-scene-per-10-seconds timeline so minute-based windows have real scenes to land on. */
function denseTimeline(totalSeconds, sceneAtSeconds = {}) {
  const scenes = [];
  for (let clockSeconds = 0; clockSeconds <= totalSeconds; clockSeconds += 10) {
    scenes.push(scene('ambient', clockSeconds, sceneAtSeconds[clockSeconds] ?? {}));
  }
  return scenes;
}

test('resolveGameViewCheckpointClipWindow spans ~1 minute either side of the moment in the normal case', () => {
  const timeline = denseTimeline(5_400, {
    3_000: { kind: 'goal_sequence', lifecycle: 'confirmed', participant: 1 },
  });
  const rail = buildGameViewCheckpointRail(timeline);
  const checkpoint = rail.checkpoints[0];
  assert.equal(checkpoint.clockSeconds, 3_000);

  const window = resolveGameViewCheckpointClipWindow(timeline, checkpoint);

  assert.equal(timeline[window.startSceneIndex].clockSeconds, 2_940, 'starts ~60s before the moment');
  assert.equal(timeline[window.endSceneIndex].clockSeconds, 3_060, 'ends ~60s after the moment');
});

test('resolveGameViewCheckpointClipWindow clamps the start at kickoff for an early moment', () => {
  const timeline = denseTimeline(5_400, {
    20: { kind: 'goal_sequence', lifecycle: 'confirmed', participant: 1 },
  });
  const rail = buildGameViewCheckpointRail(timeline);
  const checkpoint = rail.checkpoints[0];

  const window = resolveGameViewCheckpointClipWindow(timeline, checkpoint);

  assert.equal(window.startSceneIndex, 0, 'clamped to kickoff, never negative');
  assert.equal(timeline[window.endSceneIndex].clockSeconds, 80, 'still ends ~60s after the moment');
});

test('resolveGameViewCheckpointClipWindow clamps the end at the final whistle for a late moment', () => {
  const timeline = denseTimeline(5_400, {
    5_390: { kind: 'goal_sequence', lifecycle: 'confirmed', participant: 2 },
  });
  const rail = buildGameViewCheckpointRail(timeline);
  const checkpoint = rail.checkpoints[0];

  const window = resolveGameViewCheckpointClipWindow(timeline, checkpoint);

  assert.equal(window.endSceneIndex, timeline.length - 1, 'clamped to the last scene, never past the end');
  assert.equal(timeline[window.startSceneIndex].clockSeconds, 5_330, 'still starts ~60s before the moment');
});

// ---------------------------------------------------------------------------
// Goal clip tail (fix round item 2): the clip must extend PAST the
// goal_sequence scene's own celebration, never stop exactly on it -- see
// game-view-checkpoint-logic.ts's GOAL_CLIP_TAIL_SCENE_COUNT doc comment for
// why (the highlights/clip watcher effect in gamecrew-screens.tsx reacts to
// the playhead LANDING on the stop scene, not to that scene's own duration
// having elapsed).
// ---------------------------------------------------------------------------

test('a goal checkpoint\'s clip window always ends a few scenes past the goal_sequence scene itself, never on it', () => {
  const timeline = denseTimeline(5_400, {
    3_000: { kind: 'goal_sequence', lifecycle: 'confirmed', participant: 1 },
  });
  const rail = buildGameViewCheckpointRail(timeline);
  const checkpoint = rail.checkpoints[0];
  assert.equal(checkpoint.kind, 'goal');

  const window = resolveGameViewCheckpointClipWindow(timeline, checkpoint);

  assert.ok(
    window.endSceneIndex > checkpoint.sceneIndex,
    'the stop index must land strictly after the goal_sequence scene, not on it',
  );
});

test('a goal right at the final whistle still gets whatever tail the timeline actually has, clamped to the last scene', () => {
  // Only two scenes exist after the goal itself -- fewer than the full tail
  // floor -- so the window must clamp to the last available scene rather
  // than running off the end of the timeline.
  const timeline = [
    ...denseTimeline(5_390),
    scene('goal_sequence', 5_400 + 120, { lifecycle: 'confirmed', participant: 2 }), // 90+2'
    scene('restart', 5_400 + 121, { lifecycle: 'confirmed' }),
    scene('phase_break', 5_400 + 122, { sourceAction: 'full_time' }),
  ];
  const rail = buildGameViewCheckpointRail(timeline);
  const checkpoint = rail.checkpoints.find((candidate) => candidate.kind === 'goal');
  assert.ok(checkpoint, 'sanity: the late goal is on the rail');

  const window = resolveGameViewCheckpointClipWindow(timeline, checkpoint);

  assert.equal(window.endSceneIndex, timeline.length - 1, 'clamped to the last scene, never past the end');
  assert.ok(
    window.endSceneIndex > checkpoint.sceneIndex,
    'still extends past the goal_sequence scene itself even this close to the final whistle',
  );
});

test('a provisional goal_sequence scene immediately followed by its confirmed sibling counts as one contiguous run for the tail floor', () => {
  const timeline = [
    ...denseTimeline(600),
    scene('goal_sequence', 610, { lifecycle: 'provisional' }),
    scene('goal_sequence', 615, {
      lifecycle: 'confirmed',
      participant: 1,
      beats: [{ kind: 'celebration', lifecycle: 'confirmed', sourceFrameIds: ['goal-frame'] }],
    }),
    ...denseTimeline(600).map((entry, index) => scene('ambient', 620 + index * 10)),
  ];
  const rail = buildGameViewCheckpointRail(timeline);
  const checkpoint = rail.checkpoints.find((candidate) => candidate.kind === 'goal');
  assert.ok(checkpoint, 'sanity: the confirmed sibling is the checkpoint (the provisional one is not)');

  const window = resolveGameViewCheckpointClipWindow(timeline, checkpoint);

  assert.ok(
    window.endSceneIndex > checkpoint.sceneIndex,
    'the tail is measured past the confirmed sibling, not the provisional one',
  );
});

test('the goal clip tail does not shrink the normal ~60s-after window when the timeline has plenty of scenes', () => {
  // Early in the match, far from the final whistle -- the clock-based +60s
  // window already reaches well past the tail floor, so the tail fix must
  // not shrink or otherwise disturb it.
  const timeline = denseTimeline(5_400, {
    600: { kind: 'goal_sequence', lifecycle: 'confirmed', participant: 1 },
  });
  const rail = buildGameViewCheckpointRail(timeline);
  const checkpoint = rail.checkpoints[0];

  const window = resolveGameViewCheckpointClipWindow(timeline, checkpoint);

  assert.equal(timeline[window.endSceneIndex].clockSeconds, 660, 'still ends ~60s after the moment, same as before this fix');
});

test('resolveGameViewCheckpointClipWindow preserves the 2-scene lead-in when the minute-based start would be later', () => {
  // Sparse timeline: only two scenes exist near the moment, both well within
  // one minute of the checkpoint's own clock -- the minute-based search would
  // land ON the checkpoint's own scene (index 2), but the 2-scene lead-in
  // should still win and start at index 0.
  const timeline = [
    scene('ambient', 0),
    scene('ambient', 5),
    scene('goal_sequence', 10, { lifecycle: 'confirmed', participant: 1 }),
    scene('ambient', 200),
  ];
  const rail = buildGameViewCheckpointRail(timeline);
  const checkpoint = rail.checkpoints[0];
  assert.equal(checkpoint.sceneIndex, 2);

  const window = resolveGameViewCheckpointClipWindow(timeline, checkpoint);

  assert.equal(window.startSceneIndex, 0, 'the 2-scene lead-in floor wins over the later minute-based start');
});

// ---------------------------------------------------------------------------
// Play-highlights sequencing (item 13)
// ---------------------------------------------------------------------------

test('buildGameViewHighlightsSequence orders clip windows for every goal/card/var checkpoint in match order', () => {
  const timeline = denseTimeline(5_400, {
    600: { kind: 'goal_sequence', lifecycle: 'confirmed', participant: 1 },
    3_600: { kind: 'card', lifecycle: 'confirmed', sourceAction: 'red_card', participant: 2 },
  });
  const rail = buildGameViewCheckpointRail(timeline);

  const sequence = buildGameViewHighlightsSequence(timeline, rail.checkpoints);

  assert.equal(sequence.length, 2);
  assert.ok(sequence[0].startSceneIndex < sequence[1].startSceneIndex, 'stays in match order');
  assert.equal(sequence[0].checkpointId, rail.checkpoints[0].id);
  assert.equal(sequence[1].checkpointId, rail.checkpoints[1].id);
});

test('buildGameViewHighlightsSequence merges an overlapping window into the tail of the previous clip', () => {
  // Two checkpoints only 40s apart -- well inside the +/-60s window, so their
  // clips overlap. The second clip's start must be pulled forward to right
  // after the first clip's end so no scene plays twice.
  const timeline = denseTimeline(5_400, {
    1_000: { kind: 'goal_sequence', lifecycle: 'confirmed', participant: 1 },
    1_040: { kind: 'var_review', lifecycle: 'confirmed' },
  });
  const rail = buildGameViewCheckpointRail(timeline);

  const sequence = buildGameViewHighlightsSequence(timeline, rail.checkpoints);

  assert.equal(sequence.length, 2, 'both checkpoints still get a clip, just non-overlapping');
  assert.equal(sequence[1].startSceneIndex, sequence[0].endSceneIndex + 1, 'picks up exactly where the first clip left off');
  assert.ok(sequence[1].startSceneIndex <= sequence[1].endSceneIndex);
});

test('buildGameViewHighlightsSequence skips a checkpoint whose entire window is already swallowed by the previous clip', () => {
  // A VAR review one scene after a goal, both inside the goal's own +60s
  // tail -- the VAR moment's whole window falls inside the goal's clip, so
  // it must not produce a separate (redundant) entry.
  const timeline = [
    scene('goal_sequence', 1_010, { lifecycle: 'confirmed', participant: 1 }),
    scene('var_review', 1_015, { lifecycle: 'confirmed' }),
  ];
  const rail = buildGameViewCheckpointRail(timeline);
  assert.equal(rail.checkpoints.length, 2, 'sanity: both checkpoints exist on the rail');

  const sequence = buildGameViewHighlightsSequence(timeline, rail.checkpoints);

  assert.equal(sequence.length, 1, 'the fully-swallowed VAR checkpoint produces no separate clip');
  assert.equal(sequence[0].checkpointId, rail.checkpoints[0].id);
});

test('resolveGameViewHighlightsAdvance advances through the sequence and settles after the last clip', () => {
  const sequence = [
    { checkpointId: 'a', startSceneIndex: 0, endSceneIndex: 5 },
    { checkpointId: 'b', startSceneIndex: 6, endSceneIndex: 10 },
  ];

  const first = resolveGameViewHighlightsAdvance(sequence, 0);
  assert.deepEqual(first, { kind: 'advance', nextIndex: 1, window: sequence[1] });

  const last = resolveGameViewHighlightsAdvance(sequence, 1);
  assert.deepEqual(last, { kind: 'settle' });
});

test('resolveGameViewHighlightsAdvance settles immediately for an empty sequence', () => {
  assert.deepEqual(resolveGameViewHighlightsAdvance([], -1), { kind: 'settle' });
});

// ---------------------------------------------------------------------------
// Scorer timeline derivation (item 12)
// ---------------------------------------------------------------------------

test('parseGoalScorerName parses the engine fallback shape with and without a trailing score', () => {
  assert.equal(parseGoalScorerName('Anthony Gordon scores for England. 1-0.'), 'Anthony Gordon');
  assert.equal(parseGoalScorerName('Lautaro Javier Martinez scores for Argentina.'), 'Lautaro Javier Martinez');
});

test('parseGoalScorerName is graceful (returns undefined) when the text does not lead with a name', () => {
  assert.equal(parseGoalScorerName('Goal for Argentina. 1-2.'), undefined);
  assert.equal(parseGoalScorerName('What a strike from outside the box!'), undefined);
  assert.equal(parseGoalScorerName(undefined), undefined);
  assert.equal(parseGoalScorerName(''), undefined);
});

// Item 6 (round 5): real enriched-commentary lines observed in production,
// which the original fallback-only pattern (anchored to the very start of
// the string, matching only "<Name> scores for <Team>") failed to parse
// because enriched lines often lead with a team-reaction clause before
// naming the scorer.
test('parseGoalScorerName parses a real enriched line that opens with a team reaction before the scorer', () => {
  assert.equal(
    parseGoalScorerName('Argentina have it! Enzo Fernandez finds the goal, and we are level at 1-1! Buzzing from the stands.'),
    'Enzo Fernandez',
  );
});

test('parseGoalScorerName parses a real enriched "<Name> scores!" line followed by other sentences', () => {
  assert.equal(
    parseGoalScorerName('Lautaro Martinez scores! Argentina lead 2-1 - they have won it at the death!'),
    'Lautaro Martinez',
  );
});

test('parseGoalScorerName still parses the engine fallback shape after the pattern extension', () => {
  assert.equal(parseGoalScorerName('Anthony Gordon scores for England. 1-0.'), 'Anthony Gordon');
});

test('buildGameViewScorerTimeline still renders team + minute with no name when a row does not match any known pattern', () => {
  const timeline = [
    scene('goal_sequence', 600, { lifecycle: 'confirmed', participant: 2 }),
  ];
  const rail = buildGameViewCheckpointRail(timeline);
  const entries = [
    { id: 'e1', cueIds: [], sourceFrameIds: timeline[0].sourceFrameIds, commentary: 'Chaos in the box and the ball is in the net!' },
  ];

  const scorerTimeline = buildGameViewScorerTimeline(timeline, rail.checkpoints, entries);

  assert.equal(scorerTimeline.length, 1, 'the row still renders even though no pattern matched');
  assert.equal(scorerTimeline[0].scorerName, undefined);
  assert.equal(scorerTimeline[0].participant, 2);
  assert.equal(scorerTimeline[0].minute, 10);
});

test('buildGameViewScorerTimeline derives team, minute, and parsed scorer name for every goal checkpoint', () => {
  const timeline = [
    scene('goal_sequence', 3_300, {
      lifecycle: 'confirmed',
      participant: 1,
      sourceCueIds: ['cue:goal:gordon'],
      sourceFrameIds: ['frame:goal:gordon'],
    }),
    scene('goal_sequence', 5_400 + 120, {
      lifecycle: 'confirmed',
      participant: 2,
      sourceCueIds: ['cue:goal:martinez'],
      sourceFrameIds: ['frame:goal:martinez'],
    }),
  ];
  const rail = buildGameViewCheckpointRail(timeline);
  const entries = [
    {
      id: 'commentary:gordon-goal',
      cueIds: ['cue:goal:gordon'],
      sourceFrameIds: ['frame:goal:gordon'],
      commentary: 'Anthony Gordon scores for England. 1-0.',
    },
    {
      id: 'commentary:martinez-goal',
      cueIds: ['cue:goal:martinez'],
      sourceFrameIds: ['frame:goal:martinez'],
      commentary: 'Lautaro Javier Martinez scores for Argentina. 1-2.',
    },
  ];

  const scorerTimeline = buildGameViewScorerTimeline(timeline, rail.checkpoints, entries);

  assert.equal(scorerTimeline.length, 2);
  assert.deepEqual(scorerTimeline[0], {
    checkpointId: rail.checkpoints[0].id,
    participant: 1,
    minute: 55,
    minuteLabel: '55′',
    scorerName: 'Anthony Gordon',
  });
  assert.equal(scorerTimeline[1].scorerName, 'Lautaro Javier Martinez');
  assert.equal(scorerTimeline[1].minuteLabel, '90+2′', 'stoppage time past 90 reads as 90+N');
});

test('buildGameViewScorerTimeline still returns a row (without a name) when parsing fails or no entry matches', () => {
  const timeline = [
    scene('goal_sequence', 600, { lifecycle: 'confirmed', participant: 1 }),
  ];
  const rail = buildGameViewCheckpointRail(timeline);

  const noEntries = buildGameViewScorerTimeline(timeline, rail.checkpoints, []);
  assert.equal(noEntries.length, 1);
  assert.equal(noEntries[0].scorerName, undefined);
  assert.equal(noEntries[0].participant, 1);
  assert.equal(noEntries[0].minute, 10);

  const unparsableEntries = [
    { id: 'e1', cueIds: [], sourceFrameIds: timeline[0].sourceFrameIds, commentary: 'Goal for England. 1-0.' },
  ];
  const unparsable = buildGameViewScorerTimeline(timeline, rail.checkpoints, unparsableEntries);
  assert.equal(unparsable[0].scorerName, undefined);
});

// ---------------------------------------------------------------------------
// Scorer display rows (fix round item 13b): clustered nameless goals
// ---------------------------------------------------------------------------

test('buildGameViewScorerRows keeps a named scorer as its own row, unchanged shape', () => {
  const scorerTimeline = [
    { checkpointId: 'c1', participant: 1, minute: 55, minuteLabel: "55′", scorerName: 'Anthony Gordon' },
  ];

  const rows = buildGameViewScorerRows(scorerTimeline);

  assert.deepEqual(rows, [
    { kind: 'named', checkpointId: 'c1', participant: 1, minute: 55, scorerName: 'Anthony Gordon' },
  ]);
});

test('buildGameViewScorerRows clusters a team\'s nameless goals into one row instead of one per goal', () => {
  const scorerTimeline = [
    { checkpointId: 'c1', participant: 1, minute: 3, minuteLabel: "3′", scorerName: undefined },
    { checkpointId: 'c2', participant: 1, minute: 18, minuteLabel: "18′", scorerName: undefined },
    { checkpointId: 'c3', participant: 1, minute: 37, minuteLabel: "37′", scorerName: undefined },
  ];

  const rows = buildGameViewScorerRows(scorerTimeline);

  assert.equal(rows.length, 1, 'one clustered row, not three bare Goal rows');
  assert.deepEqual(rows[0], {
    kind: 'cluster',
    checkpointId: 'c1+c2+c3',
    participant: 1,
    minutes: [3, 18, 37],
  });
});

test('buildGameViewScorerRows keeps each team\'s nameless-goal cluster separate', () => {
  const scorerTimeline = [
    { checkpointId: 'c1', participant: 1, minute: 10, minuteLabel: "10′", scorerName: undefined },
    { checkpointId: 'c2', participant: 2, minute: 20, minuteLabel: "20′", scorerName: undefined },
    { checkpointId: 'c3', participant: 1, minute: 30, minuteLabel: "30′", scorerName: undefined },
  ];

  const rows = buildGameViewScorerRows(scorerTimeline);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((row) => row.participant === 1).minutes, [10, 30]);
  assert.deepEqual(rows.find((row) => row.participant === 2).minutes, [20]);
});

test('buildGameViewScorerRows interleaves named rows and a team\'s nameless cluster, each at its earliest goal\'s position', () => {
  const scorerTimeline = [
    { checkpointId: 'c1', participant: 1, minute: 5, minuteLabel: "5′", scorerName: undefined },
    { checkpointId: 'c2', participant: 2, minute: 40, minuteLabel: "40′", scorerName: 'Lautaro Martinez' },
    { checkpointId: 'c3', participant: 1, minute: 60, minuteLabel: "60′", scorerName: undefined },
  ];

  const rows = buildGameViewScorerRows(scorerTimeline);

  assert.equal(rows.length, 2, 'the two participant-1 nameless goals still collapse into one row');
  assert.equal(rows[0].kind, 'cluster');
  assert.deepEqual(rows[0].minutes, [5, 60]);
  assert.equal(rows[1].kind, 'named');
  assert.equal(rows[1].scorerName, 'Lautaro Martinez');
});

test('buildGameViewScorerRows returns an empty list for an empty scorer timeline', () => {
  assert.deepEqual(buildGameViewScorerRows([]), []);
});

// Item 13c: verifies the exact production-observed Lautaro 90+2' line
// (from the owner's demo match) parses to a name end-to-end through the
// scorer timeline AND row builder, so the recap really does show his name
// rather than falling into the nameless cluster.
test('item 13c: the Lautaro 90+2\' commentary line resolves to a named row, not a nameless cluster', () => {
  const timeline = [
    scene('goal_sequence', 5_400 + 120, {
      lifecycle: 'confirmed',
      participant: 2,
      sourceCueIds: ['cue:goal:martinez'],
      sourceFrameIds: ['frame:goal:martinez'],
    }),
  ];
  const rail = buildGameViewCheckpointRail(timeline);
  const entries = [
    {
      id: 'commentary:martinez-goal',
      cueIds: ['cue:goal:martinez'],
      sourceFrameIds: ['frame:goal:martinez'],
      commentary: 'Lautaro Martinez scores! Argentina lead 2-1 - they have won it at the death!',
    },
  ];

  const scorerTimeline = buildGameViewScorerTimeline(timeline, rail.checkpoints, entries);
  assert.equal(scorerTimeline[0].scorerName, 'Lautaro Martinez');
  assert.equal(scorerTimeline[0].minuteLabel, '90+2′');

  const rows = buildGameViewScorerRows(scorerTimeline);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'named');
  assert.equal(rows[0].scorerName, 'Lautaro Martinez');
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
