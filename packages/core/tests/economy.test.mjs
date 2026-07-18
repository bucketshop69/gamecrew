import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEconomyTimeline,
  foldEconomyBalances,
  ECONOMY_FIXED_STAKE_COOLNESS,
  ECONOMY_LOSS_COOLNESS_DIP,
  ECONOMY_STARTING_COOLNESS,
  ECONOMY_WIN_COOLNESS_GAIN,
} from '../src/match-engine/index.ts';

const FIXTURE_ID = 999002;
const USER_ID = 'user-1';

let seqCounter = 0;

function nextSeq() {
  seqCounter += 1;
  return seqCounter;
}

/** Builds a minimal-but-valid SimulationCue carrying only the fields economy.ts reads. */
function cue(overrides) {
  return {
    id: overrides.id ?? `cue:${FIXTURE_ID}:${overrides.kind}:${nextSeq()}`,
    kind: overrides.kind,
    updateMode: overrides.updateMode ?? 'incident_upsert',
    lifecycle: overrides.lifecycle ?? 'observed',
    basis: overrides.basis ?? 'direct',
    revision: overrides.revision ?? 1,
    participant: overrides.participant,
    teamId: overrides.teamId,
    player: overrides.player,
    value: overrides.value ?? {},
    occurrenceSeconds: overrides.occurrenceSeconds,
    sourceSeqs: overrides.sourceSeqs ?? [nextSeq()],
    factIds: overrides.factIds ?? [],
  };
}

/** Builds a minimal-but-valid SemanticFrame with a single seq and the given cues. */
function frame(overrides) {
  const seq = overrides.seq ?? nextSeq();
  return {
    id: overrides.id ?? `frame:${FIXTURE_ID}:${seq}`,
    fixtureId: FIXTURE_ID,
    seq,
    stateRevision: overrides.stateRevision ?? seq,
    sourceTimestamp: overrides.sourceTimestamp,
    matchClockSeconds: overrides.matchClockSeconds,
    facts: overrides.facts ?? [],
    simulationCues: overrides.cues ?? [],
  };
}

test.beforeEach(() => {
  seqCounter = 0;
});

test('offers a welcome gift on the first frame and grants it once claimed', () => {
  const frames = [
    frame({ matchClockSeconds: 0 }),
    frame({ matchClockSeconds: 5 }),
  ];
  const events = buildEconomyTimeline(frames, {
    userId: USER_ID,
    actions: [{ kind: 'gift_claimed', anchorFrameId: frames[0].id, claimedAt: 1000 }],
  });

  const offered = events.find((event) => event.kind === 'welcome_gift_offered');
  assert.ok(offered, 'welcome_gift_offered must be emitted on the first frame');
  assert.equal(offered.sourceFrameId, frames[0].id);

  const granted = events.find((event) => event.kind === 'gift_granted');
  assert.ok(granted, 'gift_granted must be emitted once the user claims');
  assert.equal(granted.coolnessDelta, ECONOMY_STARTING_COOLNESS);
  assert.ok(granted.itemDeltas.length >= 2 && granted.itemDeltas.length <= 4, 'gift grants 2-4 distinct items');
  for (const itemDelta of granted.itemDeltas) {
    assert.ok(itemDelta.delta >= 1 && itemDelta.delta <= 24, 'each granted item has a 1-24 quantity');
  }
});

test('offers "goal in the first half" prompt at first_half kickoff', () => {
  const frames = [
    frame({ matchClockSeconds: 0, cues: [cue({ kind: 'phase_change', value: { phase: 'first_half_ready' } })] }),
    frame({ matchClockSeconds: 0, cues: [cue({ kind: 'phase_change', value: { phase: 'first_half' } })] }),
  ];
  const events = buildEconomyTimeline(frames, { userId: USER_ID });
  const prompt = events.find((event) => event.kind === 'prompt_offered' && event.betPredicate === 'goal_in_first_half');
  assert.ok(prompt, 'first-half prompt must be offered when phase_change -> first_half lands');
});

test('offers "goal in the next 2 minutes" after a corner cue, and only once per corner', () => {
  const cornerCue = cue({ kind: 'set_piece', participant: 1, value: { action: 'corner' } });
  const frames = [
    frame({ matchClockSeconds: 0, cues: [cue({ kind: 'phase_change', value: { phase: 'first_half' } })] }),
    frame({ matchClockSeconds: 600, cues: [cornerCue] }),
    frame({ matchClockSeconds: 601, cues: [cornerCue] }), // duplicate/re-delivered cue, same id
  ];
  const events = buildEconomyTimeline(frames, { userId: USER_ID });
  const cornerPrompts = events.filter((event) => event.kind === 'prompt_offered' && event.betPredicate === 'goal_within_window');
  assert.equal(cornerPrompts.length, 1, 'a corner must only ever produce one prompt, even if the cue is re-delivered');
});

test('offers "score before the break" when approaching half-time', () => {
  const frames = [
    frame({ matchClockSeconds: 0, cues: [cue({ kind: 'phase_change', value: { phase: 'first_half' } })] }),
    frame({ matchClockSeconds: 41 * 60 }),
  ];
  const events = buildEconomyTimeline(frames, { userId: USER_ID });
  const prompt = events.find((event) => event.kind === 'prompt_offered' && event.betPredicate === 'score_before_half_time');
  assert.ok(prompt, 'approaching-half-time prompt must be offered inside the fixed window');
});

test('bet_taken is echoed once a prompt is open and matched to the action', () => {
  const frames = [
    frame({ matchClockSeconds: 0, cues: [cue({ kind: 'phase_change', value: { phase: 'first_half' } })] }),
    frame({ matchClockSeconds: 10 }),
  ];
  const events = buildEconomyTimeline(frames, {
    userId: USER_ID,
    actions: [{ kind: 'bet_taken', promptId: `${FIXTURE_ID}:economy:prompt:first_half_goal`, itemId: 'bananas' }],
  });
  const taken = events.find((event) => event.kind === 'bet_taken');
  assert.ok(taken, 'bet_taken must be emitted once matched to an open prompt');
  assert.equal(taken.coolnessDelta, -ECONOMY_FIXED_STAKE_COOLNESS);
  assert.equal(taken.stakedItem, 'bananas');
});

test('settles a bet as a win when a confirmed goal lands inside the window, paying junk sized by staked rarity', () => {
  const goalCue = cue({ kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1 });
  const frames = [
    frame({ matchClockSeconds: 0, cues: [cue({ kind: 'phase_change', value: { phase: 'first_half' } })] }),
    frame({ matchClockSeconds: 60, cues: [goalCue] }),
  ];
  const promptId = `${FIXTURE_ID}:economy:prompt:first_half_goal`;
  const events = buildEconomyTimeline(frames, {
    userId: USER_ID,
    actions: [{ kind: 'bet_taken', promptId, itemId: 'lambo' }],
  });

  const win = events.find((event) => event.kind === 'bet_settled_win');
  assert.ok(win, 'a confirmed goal inside the window must settle the bet as a win');
  assert.equal(win.coolnessDelta, ECONOMY_WIN_COOLNESS_GAIN);
  assert.equal(win.itemDeltas.length, 1);
  assert.equal(win.itemDeltas[0].item, 'bananas');
  assert.ok(win.itemDeltas[0].delta > 0);

  const taken = events.find((event) => event.kind === 'bet_taken');
  assert.equal(win.causationId, taken.id, 'a settlement must carry causationId back to the bet_taken event');
});

test('a rarer staked item wins a bigger junk payout than a common one', () => {
  function buildWinPayout(stakedItem) {
    const goalCue = cue({ kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1 });
    const frames = [
      frame({ matchClockSeconds: 0, cues: [cue({ kind: 'phase_change', value: { phase: 'first_half' } })] }),
      frame({ matchClockSeconds: 60, cues: [goalCue] }),
    ];
    const promptId = `${FIXTURE_ID}:economy:prompt:first_half_goal`;
    const events = buildEconomyTimeline(frames, {
      userId: USER_ID,
      actions: [{ kind: 'bet_taken', promptId, itemId: stakedItem }],
    });
    return events.find((event) => event.kind === 'bet_settled_win').itemDeltas[0].delta;
  }

  seqCounter = 0;
  const lamboPayout = buildWinPayout('lambo');
  seqCounter = 0;
  const dustPayout = buildWinPayout('dust');
  assert.ok(lamboPayout > dustPayout, `staking a lambo (${lamboPayout}) must pay out more bananas than staking dust (${dustPayout})`);
});

test('settles a bet as a loss when the window closes (half-time) with no goal, and the item survives', () => {
  const frames = [
    frame({ matchClockSeconds: 0, cues: [cue({ kind: 'phase_change', value: { phase: 'first_half' } })] }),
    frame({ matchClockSeconds: 45 * 60, cues: [cue({ kind: 'phase_change', value: { phase: 'half_time' } })] }),
  ];
  const promptId = `${FIXTURE_ID}:economy:prompt:first_half_goal`;
  const events = buildEconomyTimeline(frames, {
    userId: USER_ID,
    actions: [{ kind: 'bet_taken', promptId, itemId: 'bananas' }],
  });

  const loss = events.find((event) => event.kind === 'bet_settled_loss');
  assert.ok(loss, 'half-time must close the still-open first-half window as a loss');
  assert.equal(loss.coolnessDelta, -ECONOMY_LOSS_COOLNESS_DIP);
  assert.equal(loss.itemDeltas.length, 0, 'a loss must never remove the staked item');
});

test('incident_retracted voids a settled win, reversing both coolness and the junk payout', () => {
  const goalCueId = `cue:${FIXTURE_ID}:goal:retraction-case`;
  const goalCue = cue({ id: goalCueId, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1 });
  const retractCue = cue({ id: goalCueId, kind: 'incident_retracted', lifecycle: 'retracted', value: { action: 'goal' } });
  const frames = [
    frame({ matchClockSeconds: 0, cues: [cue({ kind: 'phase_change', value: { phase: 'first_half' } })] }),
    frame({ matchClockSeconds: 60, cues: [goalCue] }),
    frame({ matchClockSeconds: 65, cues: [retractCue] }),
  ];
  const promptId = `${FIXTURE_ID}:economy:prompt:first_half_goal`;
  const events = buildEconomyTimeline(frames, {
    userId: USER_ID,
    actions: [{ kind: 'bet_taken', promptId, itemId: 'bananas' }],
  });

  const win = events.find((event) => event.kind === 'bet_settled_win');
  const voided = events.find((event) => event.kind === 'bet_voided');
  assert.ok(win && voided, 'both the original win and the void correction must be present in the log');
  assert.equal(voided.causationId, win.id, 'the void must reference the settlement it corrects');
  assert.equal(voided.coolnessDelta, -win.coolnessDelta, 'the void must reverse the exact coolness delta');
  assert.deepEqual(
    voided.itemDeltas,
    win.itemDeltas.map((itemDelta) => ({ item: itemDelta.item, delta: -itemDelta.delta })),
    'the void must reverse the exact junk payout',
  );

  const balances = foldEconomyBalances(events);
  const netCoolnessFromBet = events
    .filter((event) => event.promptId === promptId)
    .reduce((sum, event) => sum + event.coolnessDelta, 0);
  assert.equal(netCoolnessFromBet, -ECONOMY_FIXED_STAKE_COOLNESS, 'after stake + win + void, only the original stake cost remains');
  assert.equal(balances.pile.bananas ?? 0, 0, 'the reversed junk payout must net to zero in the folded pile (bet_taken never touched the pile)');
});

test('duplicate frames (re-delivered/out-of-order) are idempotent: replaying the same frame twice does not double-emit events', () => {
  const cornerCue = cue({ kind: 'set_piece', participant: 1, value: { action: 'corner' } });
  const kickoffFrame = frame({ matchClockSeconds: 0, cues: [cue({ kind: 'phase_change', value: { phase: 'first_half' } })] });
  const cornerFrame = frame({ matchClockSeconds: 600, cues: [cornerCue] });

  const once = buildEconomyTimeline([kickoffFrame, cornerFrame], { userId: USER_ID });
  const withDuplicate = buildEconomyTimeline([kickoffFrame, cornerFrame, cornerFrame, kickoffFrame], { userId: USER_ID });

  assert.deepEqual(withDuplicate, once, 'duplicate/out-of-order frame delivery must not change the emitted event log');
});

test('deterministic: shuffled frame order yields the identical event sequence', () => {
  const goalCue = cue({ kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1 });
  const frames = [
    frame({ matchClockSeconds: 0, cues: [cue({ kind: 'phase_change', value: { phase: 'first_half' } })] }),
    frame({ matchClockSeconds: 600, cues: [cue({ kind: 'set_piece', participant: 1, value: { action: 'corner' } })] }),
    frame({ matchClockSeconds: 1200, cues: [goalCue] }),
    frame({ matchClockSeconds: 2700, cues: [cue({ kind: 'phase_change', value: { phase: 'half_time' } })] }),
  ];
  const actions = [{ kind: 'gift_claimed', anchorFrameId: frames[0].id, claimedAt: 1 }];

  const inOrder = buildEconomyTimeline(frames, { userId: USER_ID, actions });
  const shuffled = [...frames].sort(() => Math.random() - 0.5);
  const fromShuffled = buildEconomyTimeline(shuffled, { userId: USER_ID, actions });

  assert.deepEqual(fromShuffled, inOrder, 'shuffling input frame order must not change the resulting event timeline');
});

test('foldEconomyBalances derives coolness and pile purely from deltas', () => {
  const events = [
    { id: '1', kind: 'gift_granted', fixtureId: FIXTURE_ID, userId: USER_ID, seq: 1, sourceFrameId: 'f1', stateRevision: 1, coolnessDelta: 20, itemDeltas: [{ item: 'bananas', delta: 12 }, { item: 'lambo', delta: 1 }] },
    { id: '2', kind: 'bet_taken', fixtureId: FIXTURE_ID, userId: USER_ID, seq: 2, sourceFrameId: 'f2', stateRevision: 2, coolnessDelta: -10, itemDeltas: [] },
    { id: '3', kind: 'bet_settled_win', fixtureId: FIXTURE_ID, userId: USER_ID, seq: 3, sourceFrameId: 'f3', stateRevision: 3, coolnessDelta: 15, itemDeltas: [{ item: 'bananas', delta: 8 }] },
  ];
  const balances = foldEconomyBalances(events);
  assert.equal(balances.coolness, 25);
  assert.equal(balances.pile.bananas, 20);
  assert.equal(balances.pile.lambo, 1);
});
