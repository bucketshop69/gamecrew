import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCommentaryEnrichmentPrompt,
  buildCommentaryMinuteBatchPrompt,
  classifyMomentClass,
  classifyRelationToPrevious,
  createMatchPulseEnrichmentService,
  displayPlayerName,
  groupEntriesIntoMinuteBatches,
  validateCommentaryLlmJson,
} from '../src/match-pulse-llm.ts';

const context = {
  fixture: {
    fixtureId: 'fixture-1',
    competition: 'Test Cup',
    competitionId: 'competition-1',
    fixtureGroupId: 'group-1',
    kickoffUtc: '2026-07-12T10:00:00.000Z',
  },
  homeTeam: { id: 'home', name: 'Home' },
  awayTeam: { id: 'away', name: 'Away' },
  status: 'live',
  score: { home: 1, away: 0 },
  clock: { phase: 'second_half', label: "61'" },
  phase: 'second_half',
  sourceCounts: { snapshot: 0, history: 1, update: 0 },
  freshness: { status: 'fresh' },
  sourceEvents: [
    { sourceRef: { id: 'frame-20' } },
    { sourceRef: { id: 'frame-21' } },
  ],
  snapshotEvents: [],
  historyEvents: [],
  updateEvents: [],
};

const workerContext = {
  homeTeam: { id: 'home', name: 'Home' },
  awayTeam: { id: 'away', name: 'Away' },
  allowedSourceFrameIds: ['semantic-frame-20', 'semantic-frame-21'],
};

function entry(overrides = {}) {
  return {
    id: 'entry-1',
    fixtureId: 'fixture-1',
    batchId: 'projection-4',
    projectionGeneration: 4,
    commentaryBeatKind: 'pressure',
    sourceFrameIds: ['semantic-frame-20', 'semantic-frame-21'],
    factIds: ['fact-20', 'fact-21'],
    cueIds: ['cue-20', 'cue-21'],
    groundedFacts: [
      { id: 'cue-20', kind: 'set_piece', action: 'corner', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: { action: 'corner' }, sourceSeqs: [20] },
      { id: 'cue-21', kind: 'shot_outcome', action: 'shot', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', playerName: 'Home Striker', pressure: 'danger', value: { action: 'shot' }, sourceSeqs: [21] },
    ],
    fromSeq: 20,
    toSeq: 21,
    period: 'second_half',
    clock: { minute: 61, label: "61'" },
    kind: 'commentary',
    team: { id: 'home', name: 'Home', side: 'home' },
    scoreAtMoment: { home: 1, away: 0 },
    sourceEvents: [
      { kind: 'txline_history', id: 'frame-20', seq: 20, action: 'corner', teamName: 'Home' },
      { kind: 'txline_history', id: 'frame-21', seq: 21, action: 'shot', teamName: 'Home' },
    ],
    commentary: 'Home keep the move alive with a corner and a shot.',
    intensity: 'danger',
    momentumSide: 'home',
    confidence: 'source_backed',
    generation: 'rule_based',
    fallbackCommentary: 'Home win a corner before taking a shot.',
    enrichmentStatus: 'pending',
    ...overrides,
  };
}

test('commentary prompt carries a structured beat, coverage contract, and bounded broadcast memory', () => {
  const previous = entry({
    id: 'previous',
    batchId: 'projection-3',
    sourceEvents: [{ kind: 'txline_history', id: 'frame-19', seq: 19, action: 'corner', teamName: 'Home' }],
    commentary: 'Home win the first corner of this spell.',
  });
  const messages = buildCommentaryEnrichmentPrompt(workerContext, entry(), [previous]);
  const input = JSON.parse(messages[1].content);

  assert.deepEqual(input.contract.requiredCoveredFrameIds, ['semantic-frame-20', 'semantic-frame-21']);
  assert.equal(input.contract.projectionGeneration, 4);
  assert.equal(input.currentBeat.importance, 'developing');
  assert.equal(input.currentBeat.development, 'repeated_action');
  assert.deepEqual(input.currentBeat.mustCoverFacts.map((fact) => fact.action), ['corner', 'shot']);
  assert.equal(input.currentBeat.mustCoverFacts[1].playerName, 'Home Striker');
  assert.equal(input.currentBeat.mustCoverFacts[1].pressure, 'danger');
  assert.equal(input.broadcastMemory.recentLines[0].commentary, previous.commentary);
  assert.equal(input.broadcastMemory.recentActionCounts.corner, 1);
});

test('engine-worker grounding context rejects beats outside its semantic frame allow-list', () => {
  const current = entry();
  const candidate = {
    entryId: current.id,
    batchId: current.batchId,
    projectionGeneration: 4,
    commentary: 'Home sustain the pressure with a corner, then follow it with an effort.',
    coveredFrameIds: ['semantic-frame-20', 'semantic-frame-21'],
  };
  assert.doesNotThrow(() => validateCommentaryLlmJson(workerContext, current, candidate));
  assert.throws(
    () => validateCommentaryLlmJson(
      { ...workerContext, allowedSourceFrameIds: ['semantic-frame-20'] },
      current,
      candidate,
    ),
    /outside the worker grounding allow-list/,
  );
});

test('commentary validator enforces generation metadata, frame coverage, grounded facts, and repetition', () => {
  const current = entry();
  const valid = {
    entryId: current.id,
    batchId: current.batchId,
    projectionGeneration: 4,
    commentary: 'Home sustain the pressure with a corner, then follow it with an effort.',
    coveredFrameIds: ['semantic-frame-20', 'semantic-frame-21'],
  };
  assert.doesNotThrow(() => validateCommentaryLlmJson(context, current, valid));
  assert.throws(
    () => validateCommentaryLlmJson(context, current, { ...valid, batchId: 'stale-generation' }),
    /metadata does not match/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(context, current, { ...valid, projectionGeneration: 3 }),
    /projection generation does not match/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(context, current, { ...valid, coveredFrameIds: ['semantic-frame-20'] }),
    /did not cover required frames/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(context, current, { ...valid, commentary: 'Home force a save after the corner and shot.' }),
    /unsupported save claim/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(context, current, valid, [{ ...current, commentary: valid.commentary }]),
    /repeats a recent line/,
  );
});

test('commentary validator rejects invented players, exact locations, and unsupported continuity', () => {
  const current = entry();
  const candidate = (commentary) => ({
    entryId: current.id,
    batchId: current.batchId,
    projectionGeneration: 4,
    commentary,
    coveredFrameIds: ['semantic-frame-20', 'semantic-frame-21'],
  });
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Lionel Messi takes the corner before Home have an effort.')),
    /ungrounded proper name/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Home win a corner on the left flank before an effort.')),
    /unsupported left flank claim/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Home pin Away in their own half before winning a corner and having an effort.')),
    /unsupported own half claim/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Home move into the Away half before winning a corner and having an effort.')),
    /unsupported team-zone location claim/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Home pin Away in their own third before winning a corner and having an effort.')),
    /unsupported own third claim/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Home are pushing high before winning a corner and having an effort.')),
    /unsupported pushing high claim/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Another Home corner is followed by an effort.')),
    /continuity without a grounded earlier action/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Home take a corner before Lionel Messi has an effort.')),
    /ungrounded proper name/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Home take a corner by lionel messi before an effort.')),
    /ungrounded player/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Ronaldo takes the corner before Home have an effort.')),
    /ungrounded (?:proper name|player as the actor)/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('ronaldo takes the corner before Home have an effort.')),
    /ungrounded player as the actor/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('That spell now brings a corner and an effort for Home.')),
    /self-contained/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Another one for Home: a corner before an effort.')),
    /self-contained/,
  );
  assert.doesNotThrow(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Deep into the half, Home take a corner before an effort.')),
  );
  assert.doesNotThrow(
    () => validateCommentaryLlmJson(workerContext, current, {
      ...candidate('Home take a corner before an effort.'),
      voiceLine: 'There is more pressure from Home.',
    }),
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('El Tri take a corner before an effort.')),
    /ungrounded proper name/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Home take a corner before an effort from range goes off target.')),
    /unsupported shot range claim/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Home take a corner before an effort off target.')),
    /unsupported shot outcome claim/,
  );
});

test('commentary validator accepts sentence starters and grounded team possessives', () => {
  const current = entry();
  const candidate = (commentary) => ({
    entryId: current.id,
    batchId: current.batchId,
    projectionGeneration: 4,
    commentary,
    coveredFrameIds: ['semantic-frame-20', 'semantic-frame-21'],
  });
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext,
    current,
    candidate("Five minutes in, Home's corner leads to an effort."),
  ));
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext,
    current,
    candidate("Into the area, Home's corner leads to an effort."),
  ));
});

test('commentary validator preserves grounded counts and major-event details', () => {
  const pressure = entry({
    groundedFacts: [
      ...entry().groundedFacts,
      { id: 'cue-22', kind: 'set_piece', action: 'corner', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: { action: 'corner' }, sourceSeqs: [22] },
    ],
  });
  const pressureCandidate = {
    entryId: pressure.id,
    batchId: pressure.batchId,
    projectionGeneration: 4,
    commentary: 'Home sustain pressure with a corner and an effort.',
    coveredFrameIds: pressure.sourceFrameIds,
  };
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, pressure, pressureCandidate),
    /grounded count of 2 corners/,
  );
  assert.doesNotThrow(() => validateCommentaryLlmJson(workerContext, pressure, {
    ...pressureCandidate,
    commentary: 'Home sustain pressure with two corners and an effort.',
  }));
  assert.throws(() => validateCommentaryLlmJson(workerContext, pressure, {
    ...pressureCandidate,
    commentary: 'Home win two corners before another effort.',
  }), /continuity without a grounded earlier action/);

  const compoundName = entry({
    groundedFacts: entry().groundedFacts.map((fact, index) => index === 1 ? { ...fact, playerName: "Ava O'Brien-Saint" } : fact),
  });
  assert.doesNotThrow(() => validateCommentaryLlmJson(workerContext, compoundName, {
    entryId: compoundName.id,
    batchId: compoundName.batchId,
    projectionGeneration: 4,
    commentary: "Home take a corner before Ava O'Brien-Saint has an effort.",
    coveredFrameIds: compoundName.sourceFrameIds,
  }));

  const goal = entry({
    kind: 'goal',
    commentaryBeatKind: 'major',
    sourceFrameIds: ['semantic-frame-20'],
    scoreAtMoment: { home: 2, away: 0 },
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'goal' }],
    groundedFacts: [{ id: 'goal', kind: 'goal_confirmed', action: 'goal', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', playerName: 'Ana Silva', value: { action: 'goal' }, sourceSeqs: [20] }],
  });
  const goalCandidate = (commentary) => ({
    entryId: goal.id,
    batchId: goal.batchId,
    projectionGeneration: 4,
    commentary,
    coveredFrameIds: goal.sourceFrameIds,
  });
  assert.throws(() => validateCommentaryLlmJson(workerContext, goal, goalCandidate('Goal for Home! It is 2-0.')), /scorer name/);
  assert.throws(() => validateCommentaryLlmJson(workerContext, goal, goalCandidate('Goal for Home, scored by Ana Silva.')), /grounded score/);
  assert.doesNotThrow(() => validateCommentaryLlmJson(workerContext, goal, goalCandidate('Goal for Home, scored by Ana Silva. It is 2-0.')));
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext,
    goal,
    goalCandidate('Home strike first. Ana Silva with the goal, and they lead Away 2-0.'),
  ));
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext,
    goal,
    goalCandidate('Home have the lead! Ana Silva scores to make it 2-0.'),
  ));
  assert.doesNotThrow(() => validateCommentaryLlmJson(workerContext, goal, {
    ...goalCandidate('Goal for Home, scored by Ana Silva. It is 2-0.'),
    voiceLine: 'Ana Silva scores for Home. It is 2-0.',
  }));
  assert.doesNotThrow(() => validateCommentaryLlmJson(workerContext, {
    ...goal,
    groundedFacts: [{ ...goal.groundedFacts[0], playerName: 'Quinones Quinones, Julian Andres' }],
  }, goalCandidate('Goal for Home! Julian Quinones makes it 2-0.')));
  const willGoal = {
    ...goal,
    scoreAtMoment: { home: 1, away: 0 },
    groundedFacts: [{ ...goal.groundedFacts[0], playerName: 'Will Smallbone' }],
  };
  assert.doesNotThrow(() => validateCommentaryLlmJson(workerContext, willGoal, {
    ...goalCandidate('Goal for Home, scored by Will Smallbone. It is 1-0.'),
    voiceLine: 'Will Smallbone scores for Home. It is 1-0.',
  }));
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, goal, goalCandidate('Goal for Away, scored by Ana Silva. It is 2-0.')),
    /wrong team/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, goal, goalCandidate('Goal for Home, scored by Ana Silva. It is 2-0, not 9-9.')),
    /multiple score claims/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, goal, goalCandidate('Goal for Home, scored by Ana Silva. It is 2-0 and the stadium erupts.')),
    /crowd or stadium atmosphere/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(
      workerContext,
      goal,
      goalCandidate('Home have the lead! Ana Silva scores to make it 2-0, and you can hear the place lift.'),
    ),
    /crowd or stadium atmosphere/,
  );

  const red = entry({
    kind: 'card',
    commentaryBeatKind: 'major',
    sourceFrameIds: ['semantic-frame-20'],
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'red_card' }],
    groundedFacts: [{ id: 'red', kind: 'card', action: 'red_card', lifecycle: 'confirmed', basis: 'direct', teamId: 'away', value: { action: 'red_card' }, sourceSeqs: [20] }],
  });
  assert.throws(() => validateCommentaryLlmJson(workerContext, red, {
    entryId: red.id,
    batchId: red.batchId,
    projectionGeneration: 4,
    commentary: 'Away receive a card.',
    coveredFrameIds: red.sourceFrameIds,
  }), /red-card type/);
  assert.doesNotThrow(() => validateCommentaryLlmJson(workerContext, red, {
    entryId: red.id,
    batchId: red.batchId,
    projectionGeneration: 4,
    commentary: 'Away are shown a straight red and sent off.',
    coveredFrameIds: red.sourceFrameIds,
  }));
  assert.doesNotThrow(() => validateCommentaryLlmJson(workerContext, {
    ...red, period: 'second_half', clock: { minute: 95, label: "95'" },
  }, {
    entryId: red.id,
    batchId: red.batchId,
    projectionGeneration: 4,
    commentary: 'Away are shown a straight red in stoppage time.',
    coveredFrameIds: red.sourceFrameIds,
  }));
  assert.throws(() => validateCommentaryLlmJson(workerContext, red, {
    entryId: red.id,
    batchId: red.batchId,
    projectionGeneration: 4,
    commentary: 'Straight red for Away, and Home will see this one out a player up.',
    coveredFrameIds: red.sourceFrameIds,
  }), /future action/);
});

test('commentary cannot invent score state when the current beat has no grounded score', () => {
  const current = entry({
    scoreAtMoment: undefined,
    sourceFrameIds: ['semantic-frame-20'],
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'phase_change' }],
    groundedFacts: [{ id: 'half', kind: 'phase_change', action: 'phase_change', lifecycle: 'confirmed', basis: 'direct', value: { phase: 'half_time' }, sourceSeqs: [20] }],
  });
  const candidate = {
    entryId: current.id,
    batchId: current.batchId,
    projectionGeneration: 4,
    commentary: 'It is half-time and Home lead at the break.',
    coveredFrameIds: current.sourceFrameIds,
  };
  assert.throws(() => validateCommentaryLlmJson(workerContext, current, candidate), /score relationship/);
});

test('commentary cannot invent a physical referee action', () => {
  const current = entry();
  assert.throws(() => validateCommentaryLlmJson(workerContext, current, {
    entryId: current.id,
    batchId: current.batchId,
    projectionGeneration: 4,
    commentary: 'The referee blows before Home take a corner and have an effort.',
    coveredFrameIds: current.sourceFrameIds,
  }), /physical referee action/);
});

test('commentary validator rejects every unsupported material action claim', () => {
  const substitution = entry({
    sourceFrameIds: ['semantic-frame-20'],
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'substitution', teamName: 'Home' }],
    groundedFacts: [{ id: 'sub', kind: 'substitution', action: 'substitution', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: { action: 'substitution' }, sourceSeqs: [20] }],
  });
  const candidate = (commentary) => ({
    entryId: substitution.id,
    batchId: substitution.batchId,
    projectionGeneration: 4,
    commentary,
    coveredFrameIds: substitution.sourceFrameIds,
  });
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, substitution, candidate('Home make a substitution and win a corner.')),
    /unsupported corner claim/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, substitution, candidate('Away make a substitution.')),
    /wrong team/,
  );
});

test('commentary validator requires lifecycle meaning for every narrated cue family', () => {
  const cases = [
    {
      action: 'restart', kind: 'restart', value: { kind: 'kickoff' }, restartContext: 'initial',
      valid: 'Home get the match underway.', omitted: 'Home have the latest update.',
    },
    {
      action: 'restart', kind: 'restart', value: { kind: 'kickoff' }, restartContext: 'second_half',
      valid: 'Home get the second half underway.', omitted: 'Home restart play.',
    },
    {
      action: 'restart', kind: 'restart', value: { kind: 'kickoff' }, restartContext: 'after_goal',
      valid: 'Home restart play after the goal.', omitted: 'Home restart play.',
    },
    {
      action: 'phase_change', kind: 'phase_change', value: { phase: 'half_time' },
      valid: 'The first half is over.', omitted: 'The latest phase is complete.',
    },
    {
      action: 'phase_change', kind: 'phase_change', value: { phase: 'finalised' },
      valid: 'The match is over.', omitted: 'The latest phase is complete.',
    },
    {
      action: 'var', kind: 'var', value: { action: 'var' },
      valid: 'The incident is being checked by VAR.', omitted: 'There is an update on the incident.',
    },
    {
      action: 'injury', kind: 'injury', value: { action: 'injury' },
      valid: 'Play is stopped for an injury.', omitted: 'Play has stopped.',
    },
    {
      action: 'additional_time', kind: 'additional_time', value: { action: 'additional_time' },
      valid: 'Additional time has been indicated.', omitted: 'Time has been indicated.',
    },
  ];
  for (const [index, item] of cases.entries()) {
    const current = entry({
      id: `lifecycle-${index}`,
      sourceFrameIds: [`semantic-frame-${index}`],
      sourceEvents: [{ kind: 'system', id: `semantic-frame-${index}`, seq: index, action: item.action, teamName: 'Home' }],
      groundedFacts: [{ id: `fact-${index}`, kind: item.kind, action: item.action, lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: item.restartContext ? { ...item.value, context: item.restartContext } : item.value, sourceSeqs: [index] }],
    });
    const candidate = (commentary) => ({
      entryId: current.id, batchId: current.batchId, projectionGeneration: 4,
      commentary, coveredFrameIds: current.sourceFrameIds,
    });
    const validationContext = { homeTeam: workerContext.homeTeam, awayTeam: workerContext.awayTeam };
    assert.doesNotThrow(() => validateCommentaryLlmJson(validationContext, current, candidate(item.valid)), item.action);
    if (item.restartContext === 'after_goal') {
      assert.doesNotThrow(() => validateCommentaryLlmJson(
        validationContext,
        current,
        candidate('Home get us back underway after that goal.'),
      ));
    }
    assert.throws(() => validateCommentaryLlmJson(validationContext, current, candidate(item.omitted)), /omitted|required/, item.action);
  }
});

function serviceConfig() {
  return {
    host: '127.0.0.1',
    llmBaseUrl: 'https://llm.invalid',
    llmEnabled: true,
    llmBatchSize: 16,
    llmModel: 'test-model',
    llmTimeoutMs: 1_000,
    matchPulseStoreDriver: 'sqlite',
    matchPulseStorePath: 'unused',
    matchPulseSqlitePath: 'unused',
    port: 8787,
    txlineApiToken: 'unused',
    txlineBaseUrl: 'https://txline.invalid',
    txlineFinalisationCorrectionMs: 0,
  };
}

function mockFetchResponses(responses, requests) {
  return async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(responses.shift()) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('major beats reflect once and revise an invalid batch draft', async () => {
  const major = entry({
    kind: 'goal',
    intensity: 'major',
    scoreAtMoment: undefined,
    sourceEvents: [{ kind: 'txline_history', id: 'frame-20', seq: 20, action: 'goal', teamName: 'Home' }],
    commentaryBeatKind: 'major',
    sourceFrameIds: ['semantic-frame-20'],
    groundedFacts: [{ id: 'goal', kind: 'goal_confirmed', action: 'goal', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: { action: 'goal' }, sourceSeqs: [20] }],
    fallbackCommentary: 'Goal for Home.',
  });
  const responses = [
    { results: [{ entryId: major.id, commentary: 'Goal for Home, and the goalkeeper makes the save.', coveredFrameIds: ['semantic-frame-20'] }] },
    { entryId: major.id, batchId: major.batchId, projectionGeneration: 4, commentary: 'Goal for Home! They have the breakthrough.', coveredFrameIds: ['semantic-frame-20'] },
  ];
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchResponses(responses, requests);

  try {
    const service = createMatchPulseEnrichmentService(serviceConfig());
    const result = await service.enrichCommentaryEntries(context, [major], []);

    assert.equal(requests.length, 2);
    assert.match(requests[1].messages.at(-1).content, /"reflection":true/);
    assert.match(requests[1].messages.at(-1).content, /validationFailure/);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.entries[0].commentary, 'Goal for Home! They have the breakthrough.');
    assert.deepEqual(result.entries[0].coveredFrameIds, ['semantic-frame-20']);
    assert.equal(result.entries[0].enrichmentPromptVersion, 'engine-commentary-v3-reflection');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('major beats keep a valid batch draft when the reflection pass regresses', async () => {
  const major = entry({
    kind: 'goal',
    intensity: 'major',
    scoreAtMoment: undefined,
    sourceEvents: [{ kind: 'txline_history', id: 'frame-20', seq: 20, action: 'goal', teamName: 'Home' }],
    commentaryBeatKind: 'major',
    sourceFrameIds: ['semantic-frame-20'],
    groundedFacts: [{ id: 'goal', kind: 'goal_confirmed', action: 'goal', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: { action: 'goal' }, sourceSeqs: [20] }],
    fallbackCommentary: 'Goal for Home.',
  });
  const responses = [
    { results: [{ entryId: major.id, commentary: 'Goal for Home! They have the breakthrough.', coveredFrameIds: ['semantic-frame-20'] }] },
    { entryId: major.id, batchId: major.batchId, projectionGeneration: 4, commentary: 'Goal for Home, and the goalkeeper makes the save.', coveredFrameIds: ['semantic-frame-20'] },
  ];
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchResponses(responses, requests);

  try {
    const service = createMatchPulseEnrichmentService(serviceConfig());
    const result = await service.enrichCommentaryEntries(context, [major], []);
    assert.equal(requests.length, 2);
    assert.equal(result.completed, 1);
    assert.equal(result.entries[0].commentary, 'Goal for Home! They have the breakthrough.');
    assert.equal(result.entries[0].enrichmentPromptVersion, 'engine-commentary-v3-immediate');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pressure beats are written once inside the minute batch without a reflection request', async () => {
  const current = entry();
  const responses = [
    { results: [{
      entryId: current.id,
      commentary: 'Home keep the pressure on with a corner, then follow it with an effort.',
      coveredFrameIds: current.sourceFrameIds,
    }] },
  ];
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchResponses(responses, requests);
  try {
    const service = createMatchPulseEnrichmentService(serviceConfig());
    const result = await service.enrichCommentaryEntries(workerContext, [current], []);
    assert.equal(requests.length, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.entries[0].commentary, 'Home keep the pressure on with a corner, then follow it with an effort.');
    assert.equal(result.entries[0].enrichmentPromptVersion, 'engine-commentary-v3-immediate');
    assert.deepEqual(result.traces?.[0].stages.map((stage) => [stage.stage, stage.usage?.totalTokens]), [
      ['draft', 15],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('routine beats fail without spending a repair request', async () => {
  const current = entry({
    intensity: 'quiet', commentaryBeatKind: 'routine', sourceFrameIds: ['semantic-frame-20'],
    sourceEvents: [{ kind: 'txline_history', id: 'frame-20', seq: 20, action: 'corner' }],
    groundedFacts: [{ id: 'corner', kind: 'set_piece', action: 'corner', lifecycle: 'confirmed', basis: 'direct', value: { action: 'corner' }, sourceSeqs: [20] }],
  });
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: [{
      entryId: current.id,
      commentary: 'A save follows the corner.',
      coveredFrameIds: ['semantic-frame-20'],
    }] }) } }] }), { status: 200 });
  };
  try {
    const service = createMatchPulseEnrichmentService(serviceConfig());
    const result = await service.enrichCommentaryEntries(context, [current], []);
    assert.equal(requests, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.entries[0].enrichmentStatus, 'failed');
    assert.equal(result.entries[0].commentary, current.commentary);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('one invalid batch result fails only its own entry; the rest of the minute survives', async () => {
  const first = entry({
    id: 'entry-a', batchId: 'engine:entry-a',
    clock: { minute: 61, seconds: 3_620, label: "61'" },
    sourceFrameIds: ['semantic-frame-20'],
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'corner', teamName: 'Home' }],
    groundedFacts: [{ id: 'cue-20', kind: 'set_piece', action: 'corner', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: { action: 'corner' }, sourceSeqs: [20] }],
  });
  const second = entry({
    id: 'entry-b', batchId: 'engine:entry-b',
    clock: { minute: 61, seconds: 3_640, label: "61'" },
    sourceFrameIds: ['semantic-frame-21'],
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-21', seq: 21, action: 'shot', teamName: 'Home' }],
    groundedFacts: [{ id: 'cue-21', kind: 'shot_outcome', action: 'shot', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: { action: 'shot' }, sourceSeqs: [21] }],
  });
  const third = entry({
    id: 'entry-c', batchId: 'engine:entry-c',
    clock: { minute: 61, seconds: 3_650, label: "61'" },
    sourceFrameIds: ['semantic-frame-22'],
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-22', seq: 22, action: 'throw_in', teamName: 'Away' }],
    team: { id: 'away', name: 'Away', side: 'away' },
    groundedFacts: [{ id: 'cue-22', kind: 'set_piece', action: 'throw_in', lifecycle: 'confirmed', basis: 'direct', teamId: 'away', value: { action: 'throw_in' }, sourceSeqs: [22] }],
  });
  const responses = [
    { results: [
      { entryId: first.id, commentary: 'Home win a corner at the end of a patient move.', coveredFrameIds: ['semantic-frame-20'] },
      { entryId: second.id, commentary: 'The goalkeeper saves the Home effort.', coveredFrameIds: ['semantic-frame-21'] },
      // entry-c intentionally missing from the response.
    ] },
  ];
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchResponses(responses, requests);
  try {
    const service = createMatchPulseEnrichmentService(serviceConfig());
    const result = await service.enrichCommentaryEntries(
      { ...workerContext, allowedSourceFrameIds: ['semantic-frame-20', 'semantic-frame-21', 'semantic-frame-22'] },
      [first, second, third],
      [],
    );
    assert.equal(requests.length, 1);
    assert.deepEqual(
      result.entries.map((resultEntry) => [resultEntry.id, resultEntry.enrichmentStatus]),
      [['entry-a', 'complete'], ['entry-b', 'failed'], ['entry-c', 'failed']],
    );
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 2);
    assert.match(result.traces?.[1].failureReason ?? '', /unsupported save claim/);
    assert.match(result.traces?.[2].failureReason ?? '', /did not include a result/);
    // The single batch request is accounted once, on the first entry.
    assert.equal(result.traces?.[0].stages.length, 1);
    assert.equal(result.traces?.[1].stages.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an unreadable batch response rejects the whole call so the durable worker retries', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'not json at all' } }],
  }), { status: 200 });
  try {
    const service = createMatchPulseEnrichmentService(serviceConfig());
    await assert.rejects(
      service.enrichCommentaryEntries(context, [entry()], []),
      (error) => error?.name === 'CommentaryProviderError',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider failures reject the batch so durable workers can retry it', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('network unavailable'); };
  try {
    const service = createMatchPulseEnrichmentService({
      host: '127.0.0.1', llmBaseUrl: 'https://llm.invalid', llmEnabled: true, llmBatchSize: 4,
      llmModel: 'test-model', llmTimeoutMs: 1_000, matchPulseStoreDriver: 'sqlite',
      matchPulseStorePath: 'unused', matchPulseSqlitePath: 'unused', port: 8787,
      txlineApiToken: 'unused', txlineBaseUrl: 'https://txline.invalid', txlineFinalisationCorrectionMs: 0,
    });
    await assert.rejects(
      service.enrichCommentaryEntries(context, [entry()], []),
      (error) => error?.name === 'CommentaryProviderError' && /network unavailable/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('displayPlayerName reorders reversed CRM-style names and dedupes a repeated surname', () => {
  assert.equal(displayPlayerName('Quinones Quinones, Julian Andres'), 'Julian Andres Quinones');
  assert.equal(displayPlayerName('Jimenez Rodriguez, Raul Alonso'), 'Raul Alonso Jimenez Rodriguez');
  assert.equal(displayPlayerName('Mbappe Lottin, Kylian'), 'Kylian Mbappe Lottin');
});

test('displayPlayerName passes through names without a comma', () => {
  assert.equal(displayPlayerName('Kylian Mbappe'), 'Kylian Mbappe');
  assert.equal(displayPlayerName('Ana Silva'), 'Ana Silva');
});

test('displayPlayerName passes through single-token names', () => {
  assert.equal(displayPlayerName('Ronaldinho'), 'Ronaldinho');
});

test('displayPlayerName preserves diacritics', () => {
  assert.equal(displayPlayerName('Quiñones, Julián'), 'Julián Quiñones');
  assert.equal(displayPlayerName('Müller, Thomas'), 'Thomas Müller');
});

test('commentary validator accepts natural shortened references to reversed CRM-style scorer names', () => {
  const goalWith = (playerName) => entry({
    kind: 'goal',
    commentaryBeatKind: 'major',
    sourceFrameIds: ['semantic-frame-20'],
    scoreAtMoment: { home: 1, away: 0 },
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'goal' }],
    groundedFacts: [{ id: 'goal', kind: 'goal_confirmed', action: 'goal', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', playerName, value: { action: 'goal' }, sourceSeqs: [20] }],
  });
  const candidateFor = (goal, commentary) => ({
    entryId: goal.id,
    batchId: goal.batchId,
    projectionGeneration: 4,
    commentary,
    coveredFrameIds: goal.sourceFrameIds,
  });

  const mbappe = goalWith('Mbappe Lottin, Kylian');
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext, mbappe, candidateFor(mbappe, 'Mbappe scores for Home. It is 1-0.'),
  ));

  const quinones = goalWith('Quinones Quinones, Julian Andres');
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext, quinones, candidateFor(quinones, 'Quinones scores for Home. It is 1-0.'),
  ));

  const jimenez = goalWith('Jimenez Rodriguez, Raul Alonso');
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext, jimenez, candidateFor(jimenez, 'Jimenez finds the net and scores for Home. It is 1-0.'),
  ));

  // Full-name echo still passes.
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext, quinones, candidateFor(quinones, 'Julian Andres Quinones scores for Home. It is 1-0.'),
  ));

  // A wrong name is still rejected.
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, mbappe, candidateFor(mbappe, 'Neymar scores for Home. It is 1-0.')),
    /ungrounded proper name|scorer name/,
  );

  // Zero matched tokens still fails even for a reversed CRM-style name.
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, quinones, candidateFor(quinones, 'Home score. It is 1-0.')),
    /scorer name/,
  );
});

test('commentary validator accepts a shortened reversed CRM-style name as the sentence actor outside a goal beat', () => {
  const current = entry({
    groundedFacts: entry().groundedFacts.map((fact, index) => index === 1
      ? { ...fact, playerName: 'Jimenez Rodriguez, Raul Alonso' }
      : fact),
  });
  const candidate = (commentary) => ({
    entryId: current.id,
    batchId: current.batchId,
    projectionGeneration: 4,
    commentary,
    coveredFrameIds: ['semantic-frame-20', 'semantic-frame-21'],
  });
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext, current, candidate('Jimenez wins a corner before Home have an effort.'),
  ));
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('ronaldo takes the corner before Home have an effort.')),
    /ungrounded player as the actor/,
  );
});

test('commentary validator still requires two tokens when a single-token surname is shared by two grounded players', () => {
  const ambiguous = entry({
    kind: 'goal',
    commentaryBeatKind: 'major',
    sourceFrameIds: ['semantic-frame-20'],
    scoreAtMoment: { home: 1, away: 0 },
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'goal' }],
    groundedFacts: [
      { id: 'goal', kind: 'goal_confirmed', action: 'goal', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', playerName: 'Jimenez Rodriguez, Raul Alonso', value: { action: 'goal' }, sourceSeqs: [20] },
      { id: 'assist', kind: 'player_highlight', action: 'assist', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', playerName: 'Jimenez Garcia, Carlos', value: { action: 'assist' }, sourceSeqs: [20] },
    ],
  });
  const candidate = {
    entryId: ambiguous.id,
    batchId: ambiguous.batchId,
    projectionGeneration: 4,
    commentary: 'Jimenez scores for Home. It is 1-0.',
    coveredFrameIds: ambiguous.sourceFrameIds,
  };
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, ambiguous, candidate),
    /scorer name/,
  );
  assert.doesNotThrow(() => validateCommentaryLlmJson(workerContext, ambiguous, {
    ...candidate,
    commentary: 'Raul Alonso Jimenez scores for Home. It is 1-0.',
  }));
});

// --- narrative prompt injection --------------------------------------------

test('commentary prompt carries a compact narrative block for a goal beat, dropping derivedFrom', () => {
  const goal = entry({
    kind: 'goal',
    commentaryBeatKind: 'major',
    sourceFrameIds: ['semantic-frame-20'],
    scoreAtMoment: { home: 2, away: 1 },
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'goal' }],
    groundedFacts: [{ id: 'goal', kind: 'goal_confirmed', action: 'goal', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', playerName: 'Ana Silva', value: { action: 'goal' }, sourceSeqs: [20] }],
    narrative: {
      scoreStory: {
        before: { participant1: 1, participant2: 1 },
        after: { participant1: 2, participant2: 1 },
        events: ['lead_change'],
        leadChangeCount: 2,
        derivedFrom: ['score:20', 'goal:20'],
      },
      playerMemory: { scorerGoalsThisMatch: 1, derivedFrom: ['goal:20'] },
      timeContext: 'closing_stages',
    },
  });
  const messages = buildCommentaryEnrichmentPrompt(workerContext, goal, []);
  const input = JSON.parse(messages[1].content);
  assert.deepEqual(input.currentBeat.narrative, {
    scoreStory: {
      before: { participant1: 1, participant2: 1 },
      after: { participant1: 2, participant2: 1 },
      events: ['lead_change'],
      leadChangeCount: 2,
    },
    playerMemory: { scorerGoalsThisMatch: 1 },
    timeContext: 'closing_stages',
  });
  assert.equal(input.currentBeat.momentClass, 'elevated');
});

test('commentary prompt carries a compact narrative block for a card beat', () => {
  const card = entry({
    kind: 'card',
    commentaryBeatKind: 'major',
    scoreAtMoment: undefined,
    sourceFrameIds: ['semantic-frame-20'],
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'yellow_card' }],
    groundedFacts: [{ id: 'card', kind: 'card', action: 'yellow_card', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: { action: 'yellow_card' }, sourceSeqs: [20] }],
    narrative: {
      discipline: {
        teamYellowCount: 4,
        teamRedCount: 0,
        playerPriorYellows: 0,
        secondYellowRed: false,
        menRemainingReduced: false,
        derivedFrom: ['card:5', 'card:12', 'card:18', 'card:20'],
      },
    },
  });
  const messages = buildCommentaryEnrichmentPrompt(workerContext, card, []);
  const input = JSON.parse(messages[1].content);
  assert.deepEqual(input.currentBeat.narrative, {
    discipline: {
      teamYellowCount: 4,
      teamRedCount: 0,
      playerPriorYellows: 0,
      secondYellowRed: false,
      menRemainingReduced: false,
    },
  });
  assert.equal(input.currentBeat.momentClass, 'notable');
});

test('commentary prompt carries a compact narrative block for a pressure beat and a score on a non-goal beat', () => {
  const pressure = entry({
    narrative: {
      momentum: { pressureSpellBeats: 3, setPieceCountRecentWindow: 2, derivedFrom: ['cue-20', 'cue-21'] },
    },
  });
  const messages = buildCommentaryEnrichmentPrompt(workerContext, pressure, []);
  const input = JSON.parse(messages[1].content);
  assert.deepEqual(input.currentBeat.narrative, {
    momentum: { pressureSpellBeats: 3, setPieceCountRecentWindow: 2 },
  });
  assert.equal(input.currentBeat.momentClass, 'notable');
  // scoreAtMoment is already populated on this non-goal pressure entry
  // (threaded forward by the consumer); the prompt must surface it.
  assert.equal(input.currentBeat.score, '1-0');
});

test('commentary prompt omits the narrative key entirely when the beat has no narrative', () => {
  const messages = buildCommentaryEnrichmentPrompt(workerContext, entry(), []);
  const input = JSON.parse(messages[1].content);
  assert.equal('narrative' in input.currentBeat, false);
});

// --- classifyMomentClass ----------------------------------------------------

test('classifyMomentClass computes a deterministic tone register from beat kind and narrative', () => {
  const cases = [
    ['goal with comeback', 'goal', { scoreStory: { events: ['comeback'] } }, 'maximum'],
    ['goal with late_winner', 'goal', { scoreStory: { events: ['late_winner'] } }, 'maximum'],
    ['goal with comeback and late_winner', 'goal', { scoreStory: { events: ['comeback', 'late_winner'] } }, 'maximum'],
    ['ordinary goal', 'goal', { scoreStory: { events: ['extends_lead'] } }, 'elevated'],
    ['goal with no narrative', 'goal', undefined, 'elevated'],
    ['second-yellow red card', 'card', { discipline: { secondYellowRed: true, teamRedCount: 1, teamYellowCount: 1 } }, 'elevated'],
    ['straight red card', 'card', { discipline: { secondYellowRed: false, teamRedCount: 1, teamYellowCount: 0, menRemainingReduced: true } }, 'elevated'],
    ['yellow card after an earlier teammate red', 'card', { discipline: { secondYellowRed: false, teamRedCount: 1, teamYellowCount: 2, menRemainingReduced: false } }, 'standard'],
    ['fourth yellow for the team', 'card', { discipline: { secondYellowRed: false, teamRedCount: 0, teamYellowCount: 4 } }, 'notable'],
    ['first yellow for the team', 'card', { discipline: { secondYellowRed: false, teamRedCount: 0, teamYellowCount: 1 } }, 'standard'],
    ['card with no narrative', 'card', undefined, 'standard'],
    ['sustained pressure spell', 'pressure', { momentum: { pressureSpellBeats: 3, setPieceCountRecentWindow: 1 } }, 'notable'],
    ['short pressure spell', 'pressure', { momentum: { pressureSpellBeats: 2, setPieceCountRecentWindow: 1 } }, 'standard'],
    ['late substitution', 'substitution', { timeContext: 'stoppage' }, 'notable'],
    ['closing-stages substitution', 'substitution', { timeContext: 'closing_stages' }, 'notable'],
    ['early substitution', 'substitution', { timeContext: 'early' }, 'standard'],
    ['substitution with no narrative', 'substitution', undefined, 'standard'],
    ['routine corner', 'corner', undefined, 'standard'],
  ];
  for (const [label, kind, narrative, expected] of cases) {
    assert.equal(classifyMomentClass(kind, narrative), expected, label);
  }
});

// --- tone register selection in the system prompt --------------------------

test('the system prompt tone instruction switches deterministically by moment class', () => {
  const standardMessages = buildCommentaryEnrichmentPrompt(workerContext, entry(), []);
  assert.match(standardMessages[0].content, /calm, measured register/);

  const notable = entry({
    narrative: { momentum: { pressureSpellBeats: 3, setPieceCountRecentWindow: 1, derivedFrom: [] } },
  });
  const notableMessages = buildCommentaryEnrichmentPrompt(workerContext, notable, []);
  assert.match(notableMessages[0].content, /carries weight — let the line acknowledge it without shouting/);

  const elevated = entry({
    kind: 'goal',
    commentaryBeatKind: 'major',
    scoreAtMoment: { home: 1, away: 0 },
    narrative: {
      scoreStory: { before: { participant1: 0, participant2: 0 }, after: { participant1: 1, participant2: 0 }, events: ['opener'], leadChangeCount: 1, derivedFrom: [] },
    },
  });
  const elevatedMessages = buildCommentaryEnrichmentPrompt(workerContext, elevated, []);
  assert.match(elevatedMessages[0].content, /Higher energy, short punchy sentences, an exclamation is appropriate/);

  const maximum = entry({
    kind: 'goal',
    commentaryBeatKind: 'major',
    scoreAtMoment: { home: 2, away: 1 },
    narrative: {
      scoreStory: { before: { participant1: 1, participant2: 1 }, after: { participant1: 2, participant2: 1 }, events: ['late_winner'], leadChangeCount: 2, derivedFrom: [] },
    },
  });
  const maximumMessages = buildCommentaryEnrichmentPrompt(workerContext, maximum, []);
  assert.match(maximumMessages[0].content, /the biggest moments a match can produce/);
});

// --- validator: grounded memory claims whitelist ----------------------------

function goalEntryWith(overrides = {}) {
  return entry({
    kind: 'goal',
    commentaryBeatKind: 'major',
    sourceFrameIds: ['semantic-frame-20'],
    scoreAtMoment: { home: 2, away: 1 },
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'goal' }],
    groundedFacts: [{ id: 'goal', kind: 'goal_confirmed', action: 'goal', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', playerName: 'Ana Silva', value: { action: 'goal' }, sourceSeqs: [20] }],
    ...overrides,
  });
}

function goalCandidateFor(goal, commentary) {
  return {
    entryId: goal.id,
    batchId: goal.batchId,
    projectionGeneration: 4,
    commentary,
    coveredFrameIds: goal.sourceFrameIds,
  };
}

test('validator accepts a grounded brace claim and rejects it when the count does not match', () => {
  const brace = goalEntryWith({
    narrative: { playerMemory: { scorerGoalsThisMatch: 2, derivedFrom: [] } },
  });
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext, brace, goalCandidateFor(brace, "Ana Silva finds the net for Home, and that's her brace. It is 2-1."),
  ));

  const single = goalEntryWith({
    narrative: { playerMemory: { scorerGoalsThisMatch: 1, derivedFrom: [] } },
  });
  assert.throws(
    () => validateCommentaryLlmJson(
      workerContext, single, goalCandidateFor(single, "Ana Silva scores for Home, and that's her brace. It is 2-1."),
    ),
    /unsupported brace claim/,
  );
});

test('validator accepts a grounded hat-trick claim and rejects "hat-trick" when the count is only 2', () => {
  const hatTrick = goalEntryWith({
    narrative: { playerMemory: { scorerGoalsThisMatch: 3, derivedFrom: [] } },
  });
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext, hatTrick, goalCandidateFor(hatTrick, 'Ana Silva scores her hat-trick for Home! It is 2-1.'),
  ));

  const brace = goalEntryWith({
    narrative: { playerMemory: { scorerGoalsThisMatch: 2, derivedFrom: [] } },
  });
  assert.throws(
    () => validateCommentaryLlmJson(
      workerContext, brace, goalCandidateFor(brace, 'Ana Silva scores her hat-trick for Home! It is 2-1.'),
    ),
    /unsupported hat-trick claim/,
  );
});

test('validator accepts a grounded comeback claim and rejects it without the comeback event', () => {
  const comeback = goalEntryWith({
    narrative: {
      scoreStory: { before: { participant1: 1, participant2: 2 }, after: { participant1: 2, participant2: 2 }, events: ['comeback', 'equaliser'], leadChangeCount: 2, derivedFrom: [] },
    },
  });
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext, comeback, goalCandidateFor(comeback, 'Ana Silva scores to complete the comeback for Home! It is 2-1.'),
  ));

  const noComeback = goalEntryWith({
    narrative: {
      scoreStory: { before: { participant1: 1, participant2: 1 }, after: { participant1: 2, participant2: 1 }, events: ['lead_change'], leadChangeCount: 2, derivedFrom: [] },
    },
  });
  assert.throws(
    () => validateCommentaryLlmJson(
      workerContext, noComeback, goalCandidateFor(noComeback, 'Ana Silva scores the comeback goal for Home! It is 2-1.'),
    ),
    /unsupported comeback claim/,
  );
});

test('validator accepts a grounded equaliser claim and rejects "levels" without the equaliser event', () => {
  const equaliser = goalEntryWith({
    scoreAtMoment: { home: 1, away: 1 },
    narrative: {
      scoreStory: { before: { participant1: 0, participant2: 1 }, after: { participant1: 1, participant2: 1 }, events: ['equaliser'], leadChangeCount: 0, derivedFrom: [] },
    },
  });
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext, equaliser, goalCandidateFor(equaliser, 'Ana Silva scores to level it up for Home. It is 1-1.'),
  ));

  const noEqualiser = goalEntryWith({
    narrative: {
      scoreStory: { before: { participant1: 1, participant2: 1 }, after: { participant1: 2, participant2: 1 }, events: ['lead_change'], leadChangeCount: 2, derivedFrom: [] },
    },
  });
  assert.throws(
    () => validateCommentaryLlmJson(
      workerContext, noEqualiser, goalCandidateFor(noEqualiser, 'Ana Silva levels it up for Home. It is 2-1.'),
    ),
    /unsupported equaliser claim/,
  );
});

test('validator accepts a grounded late-winner claim and rejects it without the late_winner event or clock-grounded stoppage time', () => {
  const lateWinner = goalEntryWith({
    period: 'second_half',
    clock: { minute: 92, label: "92'" },
    narrative: {
      scoreStory: { before: { participant1: 1, participant2: 1 }, after: { participant1: 2, participant2: 1 }, events: ['late_winner'], leadChangeCount: 2, derivedFrom: [] },
      timeContext: 'stoppage',
    },
  });
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext, lateWinner, goalCandidateFor(lateWinner, 'Ana Silva scores a late winner for Home in stoppage time! It is 2-1.'),
  ));

  const notLate = goalEntryWith({
    period: 'first_half',
    clock: { minute: 30, label: "30'" },
    narrative: {
      scoreStory: { before: { participant1: 1, participant2: 1 }, after: { participant1: 2, participant2: 1 }, events: ['lead_change'], leadChangeCount: 2, derivedFrom: [] },
    },
  });
  assert.throws(
    () => validateCommentaryLlmJson(
      workerContext, notLate, goalCandidateFor(notLate, 'Ana Silva scores a late winner for Home! It is 2-1.'),
    ),
    /unsupported late-winner claim/,
  );
});

test('validator accepts a grounded fourth-yellow claim and rejects it when the team count is only 3', () => {
  const cardEntry = (teamYellowCount) => entry({
    kind: 'card',
    commentaryBeatKind: 'major',
    scoreAtMoment: undefined,
    sourceFrameIds: ['semantic-frame-20'],
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'yellow_card' }],
    groundedFacts: [{ id: 'card', kind: 'card', action: 'yellow_card', lifecycle: 'confirmed', basis: 'direct', teamId: 'away', value: { action: 'yellow_card' }, sourceSeqs: [20] }],
    narrative: {
      discipline: { teamYellowCount, teamRedCount: 0, playerPriorYellows: 0, secondYellowRed: false, menRemainingReduced: false, derivedFrom: [] },
    },
  });
  const cardCandidateFor = (card, commentary) => ({
    entryId: card.id, batchId: card.batchId, projectionGeneration: 4, commentary, coveredFrameIds: card.sourceFrameIds,
  });

  const fourth = cardEntry(4);
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext, fourth, cardCandidateFor(fourth, "Away pick up a yellow card, and that's their fourth yellow of the match."),
  ));

  const third = cardEntry(3);
  assert.throws(
    () => validateCommentaryLlmJson(
      workerContext, third, cardCandidateFor(third, "Away pick up a yellow card, and that's their fourth yellow of the match."),
    ),
    /unsupported card-count claim/,
  );
});

test('validator accepts a grounded second-yellow-red claim and rejects it without secondYellowRed', () => {
  const secondYellow = entry({
    kind: 'card',
    commentaryBeatKind: 'major',
    scoreAtMoment: undefined,
    sourceFrameIds: ['semantic-frame-20'],
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'red_card' }],
    groundedFacts: [{ id: 'red', kind: 'card', action: 'red_card', lifecycle: 'confirmed', basis: 'direct', teamId: 'away', value: { action: 'red_card' }, sourceSeqs: [20] }],
    narrative: {
      discipline: { teamYellowCount: 1, teamRedCount: 1, playerPriorYellows: 1, secondYellowRed: true, menRemainingReduced: true, derivedFrom: [] },
    },
  });
  const candidate = (commentary) => ({
    entryId: secondYellow.id, batchId: secondYellow.batchId, projectionGeneration: 4, commentary, coveredFrameIds: secondYellow.sourceFrameIds,
  });
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext, secondYellow, candidate('Away are shown a second yellow, and a straight red follows.'),
  ));

  const straightRed = {
    ...secondYellow,
    narrative: { discipline: { ...secondYellow.narrative.discipline, secondYellowRed: false, playerPriorYellows: 0 } },
  };
  assert.throws(
    () => validateCommentaryLlmJson(
      workerContext, straightRed, candidate('Away are shown a second yellow, and a straight red follows.'),
    ),
    /unsupported second-yellow claim/,
  );
});

test('validator accepts a grounded down-to-ten claim and rejects it without menRemainingReduced', () => {
  const reduced = entry({
    kind: 'card',
    commentaryBeatKind: 'major',
    scoreAtMoment: undefined,
    sourceFrameIds: ['semantic-frame-20'],
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'red_card' }],
    groundedFacts: [{ id: 'red', kind: 'card', action: 'red_card', lifecycle: 'confirmed', basis: 'direct', teamId: 'away', value: { action: 'red_card' }, sourceSeqs: [20] }],
    narrative: {
      discipline: { teamYellowCount: 0, teamRedCount: 1, playerPriorYellows: 0, secondYellowRed: false, menRemainingReduced: true, derivedFrom: [] },
    },
  });
  const candidate = (commentary) => ({
    entryId: reduced.id, batchId: reduced.batchId, projectionGeneration: 4, commentary, coveredFrameIds: reduced.sourceFrameIds,
  });
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext, reduced, candidate('Away are shown a straight red, and they are down to ten men.'),
  ));

  const notReduced = {
    ...reduced,
    narrative: { discipline: { ...reduced.narrative.discipline, menRemainingReduced: false } },
  };
  assert.throws(
    () => validateCommentaryLlmJson(
      workerContext, notReduced, candidate('Away are shown a straight red, and they are down to ten men.'),
    ),
    /unsupported men-remaining claim/,
  );
});

test('validator does not reject register-appropriate exclamation marks', () => {
  const goal = goalEntryWith({
    narrative: {
      scoreStory: { before: { participant1: 1, participant2: 1 }, after: { participant1: 2, participant2: 1 }, events: ['late_winner'], leadChangeCount: 2, derivedFrom: [] },
    },
  });
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    workerContext, goal, goalCandidateFor(goal, 'Ana Silva scores a dramatic late winner for Home! It is 2-1!'),
  ));
});

// --- relationToPrevious ------------------------------------------------------

test('classifyRelationToPrevious derives the deterministic relation from grounded facts and team identity', () => {
  const pressureFor = (teamId) => entry({
    kind: 'danger',
    team: { id: teamId, name: teamId === 'home' ? 'Home' : 'Away' },
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: undefined }],
    groundedFacts: [{ id: 'cue', kind: 'possession_pressure', lifecycle: 'observed', basis: 'inferred', teamId, value: {}, sourceSeqs: [20] }],
  });
  const restart = entry({
    kind: 'commentary',
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'restart' }],
    groundedFacts: [{ id: 'cue', kind: 'restart', action: 'restart', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: { kind: 'kickoff' }, sourceSeqs: [20] }],
  });
  const flip = entry({
    kind: 'commentary',
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: undefined }],
    groundedFacts: [{ id: 'cue', kind: 'possession_change', lifecycle: 'observed', basis: 'inferred', teamId: 'away', value: {}, sourceSeqs: [20] }],
  });
  const substitution = entry({
    kind: 'substitution',
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'substitution' }],
    groundedFacts: [{ id: 'cue', kind: 'substitution', action: 'substitution', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: { action: 'substitution' }, sourceSeqs: [20] }],
  });
  const goal = entry({
    kind: 'goal',
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'goal' }],
    groundedFacts: [{ id: 'cue', kind: 'goal_confirmed', action: 'goal', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: { action: 'goal' }, sourceSeqs: [20] }],
  });

  assert.equal(classifyRelationToPrevious(restart, undefined), 'restart_resets_spell');
  assert.equal(classifyRelationToPrevious(flip, pressureFor('home')), 'possession_flip');
  assert.equal(classifyRelationToPrevious(entry(), pressureFor('home')), 'new_attempt');
  assert.equal(classifyRelationToPrevious(substitution, pressureFor('home')), 'break_in_play');
  assert.equal(classifyRelationToPrevious(goal, pressureFor('home')), 'major_moment');
  assert.equal(classifyRelationToPrevious(pressureFor('home'), pressureFor('home')), 'continues_pressure');
  assert.equal(classifyRelationToPrevious(pressureFor('home'), pressureFor('away')), 'starts_spell');
  assert.equal(classifyRelationToPrevious(pressureFor('home'), undefined), 'starts_spell');
  assert.equal(classifyRelationToPrevious(pressureFor('home'), restart), 'starts_spell');
});

// --- minute batching ---------------------------------------------------------

test('groupEntriesIntoMinuteBatches groups by period and minute, and splits busy minutes', () => {
  const at = (id, period, minute) => entry({
    id, period, clock: { minute, seconds: (minute - 1) * 60, label: `${minute}'` },
  });
  const batches = groupEntriesIntoMinuteBatches([
    at('a', 'first_half', 46),
    at('b', 'first_half', 46),
    at('c', 'second_half', 46),
    at('d', 'second_half', 47),
  ]);
  assert.deepEqual(batches.map((batch) => batch.map((item) => item.id)), [
    ['a', 'b'],
    ['c'],
    ['d'],
  ]);

  const busy = Array.from({ length: 19 }, (_, index) => at(`busy-${index}`, 'first_half', 10));
  const split = groupEntriesIntoMinuteBatches(busy, 16);
  assert.deepEqual(split.map((batch) => batch.length), [10, 9]);
  assert.deepEqual(split.flat().map((item) => item.id), busy.map((item) => item.id));
});

// --- minute-batch prompt -----------------------------------------------------

test('the minute-batch prompt carries ordered entries, relations, and the previous three accepted lines', () => {
  const acceptedLine = (id, commentary) => entry({
    id, commentary, generation: 'llm', enrichmentStatus: 'complete',
  });
  const first = entry({ id: 'batch-1', clock: { minute: 61, seconds: 3_610, label: "61'" } });
  const second = entry({
    id: 'batch-2',
    clock: { minute: 61, seconds: 3_640, label: "61'" },
    kind: 'danger',
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-21', seq: 21, action: undefined }],
    sourceFrameIds: ['semantic-frame-21'],
    groundedFacts: [{ id: 'cue', kind: 'possession_pressure', lifecycle: 'observed', basis: 'inferred', teamId: 'home', value: {}, sourceSeqs: [21] }],
  });
  const messages = buildCommentaryMinuteBatchPrompt(
    workerContext,
    [first, second],
    undefined,
    [
      acceptedLine('old-1', 'Line one.'),
      acceptedLine('old-2', 'Line two.'),
      acceptedLine('old-3', 'Line three.'),
      acceptedLine('old-4', 'Line four.'),
    ],
  );
  const input = JSON.parse(messages[1].content);
  assert.equal(input.batch.entryCount, 2);
  assert.deepEqual(input.previousAcceptedLines.map((line) => line.commentary), [
    'Line two.', 'Line three.', 'Line four.',
  ]);
  assert.deepEqual(input.entries.map((item) => item.order), [1, 2]);
  assert.equal(input.entries[0].contract.entryId, 'batch-1');
  assert.equal(input.entries[0].currentBeat.relationToPrevious, 'new_attempt');
  assert.equal(input.entries[1].currentBeat.relationToPrevious, 'continues_pressure');
  assert.match(messages[0].content, /exactly one result for every entry/);
  assert.match(messages[0].content, /Never mention, hint at, or set up any event that appears later/);
  assert.doesNotMatch(messages[0].content, /That spell now brings/);
});

// --- loosened validators -----------------------------------------------------

test('the validator accepts grounded team demonyms as attribution, not invented names', () => {
  const franceContext = {
    homeTeam: { id: 'fr', name: 'France' },
    awayTeam: { id: 'es', name: 'Spain' },
  };
  const current = entry({
    team: { id: 'fr', name: 'France', side: 'home' },
    opponent: { id: 'es', name: 'Spain', side: 'away' },
    groundedFacts: entry().groundedFacts.map((fact) => ({ ...fact, teamId: 'fr' })),
  });
  const candidate = (commentary) => ({
    entryId: current.id,
    commentary,
    coveredFrameIds: ['semantic-frame-20', 'semantic-frame-21'],
  });
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    franceContext, current, candidate('France win a corner, and the French effort follows soon after.'),
  ));
  assert.throws(
    () => validateCommentaryLlmJson(franceContext, current, candidate('France win a corner before the Brazilian effort.')),
    /ungrounded proper name/,
  );
});

test('the validator only requires batchId and projectionGeneration echoes when the model repeats them', () => {
  const current = entry();
  const minimal = {
    entryId: current.id,
    commentary: 'Home sustain the pressure with a corner, then follow it with an effort.',
    coveredFrameIds: ['semantic-frame-20', 'semantic-frame-21'],
  };
  assert.doesNotThrow(() => validateCommentaryLlmJson(workerContext, current, minimal));
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, { ...minimal, batchId: 'wrong-batch' }),
    /metadata does not match/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, { ...minimal, projectionGeneration: 3 }),
    /projection generation does not match/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, { ...minimal, entryId: 'someone-else' }),
    /metadata does not match/,
  );
});

test('a line may look back at a recent grounded event with after/following, but never claim it as current', () => {
  const possession = entry({
    kind: 'danger',
    sourceFrameIds: ['semantic-frame-21'],
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-21', seq: 21, action: undefined }],
    groundedFacts: [{ id: 'cue-21', kind: 'possession_pressure', lifecycle: 'observed', basis: 'inferred', teamId: 'home', value: {}, sourceSeqs: [21] }],
  });
  const previousSubstitution = entry({
    id: 'previous-sub',
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-20', seq: 20, action: 'substitution', teamName: 'Home' }],
    groundedFacts: [{ id: 'cue-20', kind: 'substitution', action: 'substitution', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: { action: 'substitution' }, sourceSeqs: [20] }],
    commentary: 'Home make a change.',
  });
  const candidate = (commentary) => ({
    entryId: possession.id,
    commentary,
    coveredFrameIds: ['semantic-frame-21'],
  });
  const scopedContext = { ...workerContext, allowedSourceFrameIds: ['semantic-frame-20', 'semantic-frame-21'] };
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    scopedContext, possession, candidate('After the substitution, Home settle back into possession.'), [previousSubstitution],
  ));
  // The same event claimed as current (no backward marker) still fails.
  assert.throws(
    () => validateCommentaryLlmJson(scopedContext, possession, candidate('Home make a substitution and keep the ball.'), [previousSubstitution]),
    /unsupported substitution claim/,
  );
  // A backward reference with no grounded earlier event still fails.
  assert.throws(
    () => validateCommentaryLlmJson(scopedContext, possession, candidate('After the substitution, Home settle back into possession.'), []),
    /unsupported substitution claim/,
  );
  // A recent grounded goal may be looked back at with an explicit marker...
  const previousGoal = entry({
    id: 'previous-goal',
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-19', seq: 19, action: 'goal', teamName: 'Home' }],
    groundedFacts: [{ id: 'cue-19', kind: 'goal_confirmed', action: 'goal', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: { action: 'goal' }, sourceSeqs: [19] }],
    commentary: 'Goal for Home.',
  });
  assert.doesNotThrow(() => validateCommentaryLlmJson(
    scopedContext, possession, candidate('After the goal, Home keep the ball moving.'), [previousGoal],
  ));
  // ...but never claimed as a new current goal.
  assert.throws(
    () => validateCommentaryLlmJson(scopedContext, possession, candidate('Home score and keep the ball moving.'), [previousGoal]),
    /unsupported goal claim/,
  );
  // Penalties are never backward-referenceable.
  const previousPenalty = entry({
    id: 'previous-penalty',
    sourceEvents: [{ kind: 'system', id: 'semantic-frame-18', seq: 18, action: 'penalty', teamName: 'Home' }],
    groundedFacts: [{ id: 'cue-18', kind: 'penalty', action: 'penalty', lifecycle: 'confirmed', basis: 'direct', teamId: 'home', value: { action: 'penalty' }, sourceSeqs: [18] }],
    commentary: 'Penalty to Home.',
  });
  assert.throws(
    () => validateCommentaryLlmJson(scopedContext, possession, candidate('After the penalty, Home keep the ball moving.'), [previousPenalty]),
    /unsupported penalty claim/,
  );
});
