import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCommentaryEnrichmentPrompt,
  createMatchPulseEnrichmentService,
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
    /ungrounded proper name/,
  );
  assert.throws(
    () => validateCommentaryLlmJson(workerContext, current, candidate('ronaldo takes the corner before Home have an effort.')),
    /ungrounded player as the actor/,
  );
  assert.doesNotThrow(
    () => validateCommentaryLlmJson(workerContext, current, candidate('That spell now brings a corner and an effort for Home.')),
  );
  assert.doesNotThrow(
    () => validateCommentaryLlmJson(workerContext, current, candidate('Deep into the half, Home take a corner before an effort.')),
  );
  assert.doesNotThrow(
    () => validateCommentaryLlmJson(workerContext, current, candidate('After that spell, Home take a corner before an effort.')),
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

test('major beats reflect once and revise an invalid draft', async () => {
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
    { entryId: major.id, batchId: major.batchId, projectionGeneration: 4, commentary: 'Goal for Home, and the goalkeeper makes the save.', coveredFrameIds: ['semantic-frame-20'] },
    { entryId: major.id, batchId: major.batchId, projectionGeneration: 4, commentary: 'Goal for Home! They have the breakthrough.', coveredFrameIds: ['semantic-frame-20'] },
  ];
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(responses.shift()) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const service = createMatchPulseEnrichmentService({
      host: '127.0.0.1',
      llmBaseUrl: 'https://llm.invalid',
      llmEnabled: true,
      llmBatchSize: 4,
      llmModel: 'test-model',
      llmTimeoutMs: 1_000,
      matchPulseStoreDriver: 'sqlite',
      matchPulseStorePath: 'unused',
      matchPulseSqlitePath: 'unused',
      port: 8787,
      txlineApiToken: 'unused',
      txlineBaseUrl: 'https://txline.invalid',
      txlineFinalisationCorrectionMs: 0,
    });
    const result = await service.enrichCommentaryEntries(context, [major], []);

    assert.equal(requests.length, 2);
    assert.match(requests[1].messages.at(-1).content, /"reflection":true/);
    assert.match(requests[1].messages.at(-1).content, /validationFailure/);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.entries[0].commentary, 'Goal for Home! They have the breakthrough.');
    assert.deepEqual(result.entries[0].coveredFrameIds, ['semantic-frame-20']);
    assert.equal(result.entries[0].enrichmentPromptVersion, 'engine-commentary-v2-reflection');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pressure beats reflect a valid draft once before saving the improved line', async () => {
  const current = entry();
  const responses = [
    {
      entryId: current.id, batchId: current.batchId, projectionGeneration: 4,
      commentary: 'Home have a corner and an effort.',
      coveredFrameIds: current.sourceFrameIds,
    },
    {
      entryId: current.id, batchId: current.batchId, projectionGeneration: 4,
      commentary: 'That spell now brings a corner and an effort for Home.',
      coveredFrameIds: current.sourceFrameIds,
    },
  ];
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(responses.shift()) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const service = createMatchPulseEnrichmentService({
      host: '127.0.0.1', llmBaseUrl: 'https://llm.invalid', llmEnabled: true, llmBatchSize: 4,
      llmModel: 'test-model', llmTimeoutMs: 1_000, matchPulseStoreDriver: 'sqlite',
      matchPulseStorePath: 'unused', matchPulseSqlitePath: 'unused', port: 8787,
      txlineApiToken: 'unused', txlineBaseUrl: 'https://txline.invalid', txlineFinalisationCorrectionMs: 0,
    });
    const result = await service.enrichCommentaryEntries(workerContext, [current], []);
    assert.equal(requests.length, 2);
    const reflection = JSON.parse(requests[1].messages.at(-1).content);
    assert.equal(reflection.reflection, true);
    assert.equal(reflection.validationFailure, undefined);
    assert.equal(result.entries[0].commentary, 'That spell now brings a corner and an effort for Home.');
    assert.equal(result.entries[0].enrichmentPromptVersion, 'engine-commentary-v2-reflection');
    assert.deepEqual(result.traces?.[0].stages.map((stage) => [stage.stage, stage.commentary, stage.usage?.totalTokens]), [
      ['draft', 'Home have a corner and an effort.', 15],
      ['reflection', 'That spell now brings a corner and an effort for Home.', 15],
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
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      entryId: current.id,
      batchId: current.batchId,
      projectionGeneration: 4,
      commentary: 'A save follows the corner.',
      coveredFrameIds: ['semantic-frame-20'],
    }) } }] }), { status: 200 });
  };
  try {
    const service = createMatchPulseEnrichmentService({
      host: '127.0.0.1', llmBaseUrl: 'https://llm.invalid', llmEnabled: true, llmBatchSize: 4,
      llmModel: 'test-model', llmTimeoutMs: 1_000, matchPulseStoreDriver: 'sqlite',
      matchPulseStorePath: 'unused', matchPulseSqlitePath: 'unused', port: 8787,
      txlineApiToken: 'unused', txlineBaseUrl: 'https://txline.invalid', txlineFinalisationCorrectionMs: 0,
    });
    const result = await service.enrichCommentaryEntries(context, [current], []);
    assert.equal(requests, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.entries[0].enrichmentStatus, 'failed');
    assert.equal(result.entries[0].commentary, current.commentary);
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
