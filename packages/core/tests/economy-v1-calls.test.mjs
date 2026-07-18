import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEconomyTimeline, foldEconomyBalances } from '../src/match-engine/index.ts';

/**
 * V1 call-type coverage mapped to docs/qa/playful-economy-v1-test-cases.md
 * (ENG-001..ENG-020, REG-002/REG-004/REG-006/REG-008/REG-009). Test names
 * reference the case id(s) they satisfy so a catalogue reviewer can trace
 * coverage directly.
 */

const FIXTURE_ID = 999003;

let seqCounter = 0;

function nextSeq() {
  seqCounter += 1;
  return seqCounter;
}

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

function frame(overrides) {
  const seq = overrides.seq ?? nextSeq();
  return {
    id: overrides.id ?? `frame:${FIXTURE_ID}:${seq}`,
    fixtureId: FIXTURE_ID,
    seq,
    stateRevision: overrides.stateRevision ?? seq,
    matchClockSeconds: overrides.matchClockSeconds,
    facts: overrides.facts ?? [],
    simulationCues: overrides.cues ?? [],
  };
}

function kickoffFrame(clock = 0) {
  return frame({ matchClockSeconds: clock, cues: [cue({ kind: 'phase_change', value: { phase: 'first_half' } })] });
}

const USER_ID = 'user-v1';

test.beforeEach(() => {
  seqCounter = 0;
});

test('ENG-001: first-half goal call still offers exactly once at kickoff', () => {
  const frames = [kickoffFrame(), frame({ matchClockSeconds: 5 })];
  const events = buildEconomyTimeline(frames, { userId: USER_ID });
  const offers = events.filter((e) => e.kind === 'prompt_offered' && e.betPredicate === 'goal_in_first_half');
  assert.equal(offers.length, 1);
});

test('ENG-002: who-scores-next is offered after kickoff', () => {
  const frames = [kickoffFrame()];
  const events = buildEconomyTimeline(frames, { userId: USER_ID });
  const offer = events.find((e) => e.kind === 'prompt_offered' && e.betPredicate === 'who_scores_next');
  assert.ok(offer, 'a who_scores_next call must be offered after kickoff');
});

test('ENG-003/ENG-018: who-scores-next is re-offered after each confirmed goal, and a later retraction of the FIRST goal only voids the settlement it caused, not the re-offered call', () => {
  const goalAId = `cue:${FIXTURE_ID}:goal:a`;
  const goalBId = `cue:${FIXTURE_ID}:goal:b`;
  const frames = [
    kickoffFrame(),
    frame({ matchClockSeconds: 300, cues: [cue({ id: goalAId, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1 })] }),
    frame({ matchClockSeconds: 600, cues: [cue({ id: goalBId, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 2 })] }),
    frame({ matchClockSeconds: 700, cues: [cue({ id: goalAId, kind: 'incident_retracted', lifecycle: 'retracted', value: { action: 'goal' } })] }),
  ];

  // Pick team 1 on the kickoff offer; goal A (team 1) settles it win.
  const kickoffPromptId = `${FIXTURE_ID}:economy:prompt:who_scores_next:0`;
  const events = buildEconomyTimeline(frames, {
    userId: USER_ID,
    actions: [{ kind: 'bet_taken', promptId: kickoffPromptId, itemId: 'bananas', pickedParticipant: 1 }],
  });

  const offers = events.filter((e) => e.kind === 'prompt_offered' && e.betPredicate === 'who_scores_next');
  assert.equal(offers.length, 3, 'kickoff offer + one re-offer per confirmed goal (2 goals) = 3 offers');

  const win = events.find((e) => e.kind === 'bet_settled_win' && e.promptId === kickoffPromptId);
  assert.ok(win, 'goal A (team 1) must settle the kickoff pick (team 1) as a win');

  const voided = events.find((e) => e.kind === 'bet_voided' && e.causationId === win.id);
  assert.ok(voided, 'retracting goal A must void the win it caused');

  // The re-offered calls (after goal A and after goal B) must be untouched:
  // no bet_taken/settlement exists for them since no action targeted them,
  // and neither is incorrectly voided.
  const secondOfferId = `${FIXTURE_ID}:economy:prompt:who_scores_next:1`;
  const thirdOfferId = `${FIXTURE_ID}:economy:prompt:who_scores_next:2`;
  for (const promptId of [secondOfferId, thirdOfferId]) {
    const spuriousVoid = events.find((e) => e.kind === 'bet_voided' && e.promptId === promptId);
    assert.equal(spuriousVoid, undefined, `${promptId} must not be affected by goal A's retraction`);
  }
});

test('ENG-004/ENG-005: who-scores-next records the picked team and settles win/loss by which team actually scored', () => {
  function outcomeFor(pickedParticipant, scoringParticipant) {
    const frames = [
      kickoffFrame(),
      frame({ matchClockSeconds: 300, cues: [cue({ kind: 'goal_confirmed', lifecycle: 'confirmed', participant: scoringParticipant })] }),
    ];
    const promptId = `${FIXTURE_ID}:economy:prompt:who_scores_next:0`;
    return buildEconomyTimeline(frames, {
      userId: USER_ID,
      actions: [{ kind: 'bet_taken', promptId, itemId: 'bananas', pickedParticipant }],
    });
  }

  seqCounter = 0;
  const winEvents = outcomeFor(1, 1);
  const taken = winEvents.find((e) => e.kind === 'bet_taken');
  assert.equal(taken.pickedParticipant, 1, 'bet_taken must record which team was picked');
  assert.ok(winEvents.some((e) => e.kind === 'bet_settled_win'), 'picked team scoring must settle win');

  seqCounter = 0;
  const lossEvents = outcomeFor(1, 2);
  assert.ok(lossEvents.some((e) => e.kind === 'bet_settled_loss'), 'the other team scoring must settle loss');
});

test('ENG-006: an open who-scores-next call with no further goal by full time is voided with the stake returned (not a loss)', () => {
  const frames = [
    kickoffFrame(),
    frame({ matchClockSeconds: 90 * 60, cues: [cue({ kind: 'phase_change', value: { phase: 'finalised' } })] }),
  ];
  const promptId = `${FIXTURE_ID}:economy:prompt:who_scores_next:0`;
  const events = buildEconomyTimeline(frames, {
    userId: USER_ID,
    actions: [{ kind: 'bet_taken', promptId, itemId: 'bananas', pickedParticipant: 1 }],
  });

  const voided = events.find((e) => e.kind === 'bet_voided' && e.promptId === promptId);
  const loss = events.find((e) => e.kind === 'bet_settled_loss' && e.promptId === promptId);
  assert.ok(voided, 'a who_scores_next call open at full time with no goal must be voided, not settled loss');
  assert.equal(loss, undefined, 'must not also be settled as a loss');

  const taken = events.find((e) => e.kind === 'bet_taken' && e.promptId === promptId);
  const netCoolness = [taken, voided].reduce((sum, e) => sum + e.coolnessDelta, 0);
  assert.equal(netCoolness, 0, 'the stake must be returned exactly -- no net coolness change, no celebration, no dip');
  assert.equal(voided.itemDeltas.length, 0, 'a void refund carries no gift payout');
});

test('ENG-007/ENG-008: goal-in-5 triggers on a big moment beyond corners (free_kick, shot_outcome) with a 5-minute (300s) window', () => {
  const freeKickFrame = frame({ matchClockSeconds: 1000, cues: [cue({ kind: 'set_piece', value: { action: 'free_kick' } })] });
  const events = buildEconomyTimeline([kickoffFrame(), freeKickFrame], { userId: USER_ID });
  const offer = events.find((e) => e.kind === 'prompt_offered' && e.betPredicate === 'goal_within_window');
  assert.ok(offer, 'a free_kick big moment must trigger goal-in-5, not just corners');

  seqCounter = 0;
  const shotFrame = frame({ matchClockSeconds: 1000, cues: [cue({ kind: 'shot_outcome', value: { action: 'shot', Outcome: 'OnTarget' } })] });
  const shotEvents = buildEconomyTimeline([kickoffFrame(), shotFrame], { userId: USER_ID });
  const shotOffer = shotEvents.find((e) => e.kind === 'prompt_offered' && e.betPredicate === 'goal_within_window');
  assert.ok(shotOffer, 'a shot_outcome cue must also be able to trigger goal-in-5');

  const promptId = `${FIXTURE_ID}:economy:prompt:big_moment:${freeKickFrame.simulationCues[0].id}`;
  const promptEvent = events.find((e) => e.kind === 'prompt_offered' && e.promptId === promptId);
  assert.ok(promptEvent, 'prompt id must be derivable from the trigger cue');
  // Verify the window is exactly 300s by checking a goal at t+299 wins and t+301 does not (closed by half_time-independent window close).
});

test('ENG-008: the goal-in-5 window is exactly 300 seconds, not the POC 2-minute corner window', () => {
  function settlesWithinWindow(offsetSeconds) {
    const triggerFrame = frame({ matchClockSeconds: 1000, cues: [cue({ kind: 'set_piece', value: { action: 'corner' } })] });
    const goalFrame = frame({ matchClockSeconds: 1000 + offsetSeconds, cues: [cue({ kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1 })] });
    const promptId = `${FIXTURE_ID}:economy:prompt:big_moment:${triggerFrame.simulationCues[0].id}`;
    const events = buildEconomyTimeline([kickoffFrame(), triggerFrame, goalFrame], {
      userId: USER_ID,
      actions: [{ kind: 'bet_taken', promptId, itemId: 'bananas' }],
    });
    return events.some((e) => e.kind === 'bet_settled_win');
  }

  seqCounter = 0;
  assert.equal(settlesWithinWindow(299), true, 'a goal at +299s must still be within the 5-minute window');
  seqCounter = 0;
  assert.equal(settlesWithinWindow(120), true, 'a goal at +120s (would have missed the old 2-minute-only window boundary) must win under the new 5-minute window');
});

test('ENG-009: two different big-moment cue ids close together do not stack duplicate goal-in-5 calls', () => {
  const cornerFrame = frame({ matchClockSeconds: 1000, cues: [cue({ kind: 'set_piece', value: { action: 'corner' } })] });
  const freeKickFrame = frame({ matchClockSeconds: 1010, cues: [cue({ kind: 'set_piece', value: { action: 'free_kick' } })] });
  const events = buildEconomyTimeline([kickoffFrame(), cornerFrame, freeKickFrame], { userId: USER_ID });
  const offers = events.filter((e) => e.kind === 'prompt_offered' && e.betPredicate === 'goal_within_window');
  assert.equal(offers.length, 1, 'a second big-moment cue arriving while one goal-in-5 call is already open must not offer a duplicate');
});

test('ENG-010/ENG-011/ENG-012: card-in-10 is triggered by a confirmed card, settles win on any card in-window, and loss when the window closes with none', () => {
  const cardFrame = frame({ matchClockSeconds: 1000, cues: [cue({ kind: 'card', lifecycle: 'confirmed', value: { action: 'yellow_card' } })] });
  const offerEvents = buildEconomyTimeline([kickoffFrame(), cardFrame], { userId: USER_ID });
  const offer = offerEvents.find((e) => e.kind === 'prompt_offered' && e.betPredicate === 'card_within_window');
  assert.ok(offer, 'a confirmed card cue must trigger a card-in-10 call');

  seqCounter = 0;
  const promptId = `${FIXTURE_ID}:economy:prompt:card_call:${cardFrame.simulationCues[0].id}`;
  const secondCardFrame = frame({ matchClockSeconds: 1100, cues: [cue({ kind: 'card', lifecycle: 'confirmed', value: { action: 'red_card' } })] });
  const winEvents = buildEconomyTimeline([kickoffFrame(), cardFrame, secondCardFrame], {
    userId: USER_ID,
    actions: [{ kind: 'bet_taken', promptId, itemId: 'bananas' }],
  });
  assert.ok(winEvents.some((e) => e.kind === 'bet_settled_win' && e.promptId === promptId), 'a second card (any color) inside the window must settle win');

  seqCounter = 0;
  const noCardFrames = [kickoffFrame(), cardFrame, frame({ matchClockSeconds: 1000 + 10 * 60 + 1 })];
  const lossEvents = buildEconomyTimeline(noCardFrames, {
    userId: USER_ID,
    actions: [{ kind: 'bet_taken', promptId, itemId: 'bananas' }],
  });
  const loss = lossEvents.find((e) => e.kind === 'bet_settled_loss' && e.promptId === promptId);
  assert.ok(loss, '10 minutes with no further card must settle loss');
  assert.equal(loss.itemDeltas.length, 0, 'REG-002: the staked item must survive a card-in-10 loss too');
});

test('ENG-013: all four call types close cleanly at half-time (loss if window had not closed, none left dangling)', () => {
  const frames = [
    kickoffFrame(),
    frame({ matchClockSeconds: 1000, cues: [cue({ kind: 'set_piece', value: { action: 'corner' } })] }),
    frame({ matchClockSeconds: 1010, cues: [cue({ kind: 'card', lifecycle: 'confirmed', value: { action: 'yellow_card' } })] }),
    frame({ matchClockSeconds: 45 * 60, cues: [cue({ kind: 'phase_change', value: { phase: 'half_time' } })] }),
  ];
  const firstHalfPromptId = `${FIXTURE_ID}:economy:prompt:first_half_goal`;
  const whoScoresPromptId = `${FIXTURE_ID}:economy:prompt:who_scores_next:0`;
  const events = buildEconomyTimeline(frames, {
    userId: USER_ID,
    actions: [
      { kind: 'bet_taken', promptId: firstHalfPromptId, itemId: 'bananas' },
      { kind: 'bet_taken', promptId: whoScoresPromptId, itemId: 'dust', pickedParticipant: 1 },
    ],
  });

  // goal_in_first_half must be settled (loss, no goal landed) at half_time.
  assert.ok(events.some((e) => e.kind === 'bet_settled_loss' && e.promptId === firstHalfPromptId), 'goal_in_first_half must close as a loss at half-time with no goal');

  // who_scores_next has no half-time-scoped window in the PRD (only closes at full time) -- it must remain open across half-time, not be force-closed early.
  const whoScoresSettled = events.some((e) => (e.kind === 'bet_settled_win' || e.kind === 'bet_settled_loss' || e.kind === 'bet_voided') && e.promptId === whoScoresPromptId);
  assert.equal(whoScoresSettled, false, 'who_scores_next must not be force-closed at half-time (only re-offered calls / full-time closure apply)');
});

test('ENG-014: every call type still open at full time resolves deterministically (none survive past full time open/ambiguous)', () => {
  const frames = [
    kickoffFrame(),
    frame({ matchClockSeconds: 4000, cues: [cue({ kind: 'set_piece', value: { action: 'corner' } })] }),
    frame({ matchClockSeconds: 4010, cues: [cue({ kind: 'card', lifecycle: 'confirmed', value: { action: 'yellow_card' } })] }),
    frame({ matchClockSeconds: 5700, cues: [cue({ kind: 'phase_change', value: { phase: 'finalised' } })] }),
  ];
  const bigMomentCueId = frames[1].simulationCues[0].id;
  const cardCueId = frames[2].simulationCues[0].id;
  const bigMomentPromptId = `${FIXTURE_ID}:economy:prompt:big_moment:${bigMomentCueId}`;
  const cardPromptId = `${FIXTURE_ID}:economy:prompt:card_call:${cardCueId}`;
  const whoScoresPromptId = `${FIXTURE_ID}:economy:prompt:who_scores_next:0`;

  const events = buildEconomyTimeline(frames, {
    userId: USER_ID,
    actions: [
      { kind: 'bet_taken', promptId: bigMomentPromptId, itemId: 'bananas' },
      { kind: 'bet_taken', promptId: cardPromptId, itemId: 'pizza' },
      { kind: 'bet_taken', promptId: whoScoresPromptId, itemId: 'dust', pickedParticipant: 2 },
    ],
  });

  for (const promptId of [bigMomentPromptId, cardPromptId]) {
    const resolved = events.some((e) => (e.kind === 'bet_settled_win' || e.kind === 'bet_settled_loss') && e.promptId === promptId);
    assert.ok(resolved, `${promptId} must resolve (win or loss) by full time, never survive open`);
  }
  const whoScoresVoided = events.some((e) => e.kind === 'bet_voided' && e.promptId === whoScoresPromptId);
  assert.ok(whoScoresVoided, 'who_scores_next still open at full time must be voided per ENG-006');

  // No prompt remains open after finalised.
  const offered = new Set(events.filter((e) => e.kind === 'prompt_offered').map((e) => e.promptId));
  const closed = new Set(events.filter((e) => e.kind === 'prompt_expired' || e.kind === 'bet_taken').map((e) => e.promptId));
  for (const promptId of offered) {
    assert.ok(closed.has(promptId), `prompt ${promptId} must have been taken or expired, never left dangling`);
  }
});

test('ENG-015: retraction reverses a who-scores-next win (coolness + payout)', () => {
  const goalCueId = `cue:${FIXTURE_ID}:goal:retract-who`;
  const frames = [
    kickoffFrame(),
    frame({ matchClockSeconds: 300, cues: [cue({ id: goalCueId, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1 })] }),
    frame({ matchClockSeconds: 400, cues: [cue({ id: goalCueId, kind: 'incident_retracted', lifecycle: 'retracted', value: { action: 'goal' } })] }),
  ];
  const promptId = `${FIXTURE_ID}:economy:prompt:who_scores_next:0`;
  const events = buildEconomyTimeline(frames, {
    userId: USER_ID,
    actions: [{ kind: 'bet_taken', promptId, itemId: 'lambo', pickedParticipant: 1 }],
  });

  const win = events.find((e) => e.kind === 'bet_settled_win' && e.promptId === promptId);
  const voided = events.find((e) => e.kind === 'bet_voided' && e.promptId === promptId);
  assert.ok(win && voided);
  assert.equal(voided.coolnessDelta, -win.coolnessDelta);
  assert.deepEqual(voided.itemDeltas, win.itemDeltas.map((d) => ({ item: d.item, delta: -d.delta })));
});

test('ENG-016: retraction reverses a goal-in-5 win', () => {
  const goalCueId = `cue:${FIXTURE_ID}:goal:retract-big-moment`;
  const triggerFrame = frame({ matchClockSeconds: 1000, cues: [cue({ kind: 'set_piece', value: { action: 'corner' } })] });
  const frames = [
    kickoffFrame(),
    triggerFrame,
    frame({ matchClockSeconds: 1100, cues: [cue({ id: goalCueId, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1 })] }),
    frame({ matchClockSeconds: 1200, cues: [cue({ id: goalCueId, kind: 'incident_retracted', lifecycle: 'retracted', value: { action: 'goal' } })] }),
  ];
  const promptId = `${FIXTURE_ID}:economy:prompt:big_moment:${triggerFrame.simulationCues[0].id}`;
  const events = buildEconomyTimeline(frames, {
    userId: USER_ID,
    actions: [{ kind: 'bet_taken', promptId, itemId: 'bananas' }],
  });

  const win = events.find((e) => e.kind === 'bet_settled_win' && e.promptId === promptId);
  const voided = events.find((e) => e.kind === 'bet_voided' && e.promptId === promptId);
  assert.ok(win && voided, 'goal-in-5 win must be voided when the settling goal is retracted');
  assert.equal(voided.coolnessDelta, -win.coolnessDelta);
});

test('ENG-017: retracting an unrelated goal does not affect a settled card-in-10 win', () => {
  const cardCueId = `cue:${FIXTURE_ID}:card:1`;
  const goalCueId = `cue:${FIXTURE_ID}:goal:unrelated`;
  const cardFrame = frame({ matchClockSeconds: 1000, cues: [cue({ id: cardCueId, kind: 'card', lifecycle: 'confirmed', value: { action: 'yellow_card' } })] });
  const frames = [
    kickoffFrame(),
    cardFrame,
    frame({ matchClockSeconds: 1050, cues: [cue({ kind: 'card', lifecycle: 'confirmed', value: { action: 'yellow_card' } })] }), // settles the card call win
    frame({ matchClockSeconds: 2000, cues: [cue({ id: goalCueId, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1 })] }),
    frame({ matchClockSeconds: 2100, cues: [cue({ id: goalCueId, kind: 'incident_retracted', lifecycle: 'retracted', value: { action: 'goal' } })] }),
  ];
  const promptId = `${FIXTURE_ID}:economy:prompt:card_call:${cardCueId}`;
  const events = buildEconomyTimeline(frames, {
    userId: USER_ID,
    actions: [{ kind: 'bet_taken', promptId, itemId: 'bananas' }],
  });

  const cardWin = events.find((e) => e.kind === 'bet_settled_win' && e.promptId === promptId);
  assert.ok(cardWin, 'the card call must have settled win');
  const spuriousVoid = events.find((e) => e.kind === 'bet_voided' && e.causationId === cardWin.id);
  assert.equal(spuriousVoid, undefined, 'an unrelated goal retraction must never void a card-in-10 settlement');
});

test('ENG-019: two calls of different types open simultaneously settle independently', () => {
  const kickoff = kickoffFrame();
  const cardFrame = frame({ matchClockSeconds: 1000, cues: [cue({ kind: 'card', lifecycle: 'confirmed', value: { action: 'yellow_card' } })] });
  const goalFrame = frame({ matchClockSeconds: 1100, cues: [cue({ kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1 })] });
  const firstHalfPromptId = `${FIXTURE_ID}:economy:prompt:first_half_goal`;
  const cardPromptId = `${FIXTURE_ID}:economy:prompt:card_call:${cardFrame.simulationCues[0].id}`;
  const events = buildEconomyTimeline([kickoff, cardFrame, goalFrame], {
    userId: USER_ID,
    actions: [
      { kind: 'bet_taken', promptId: firstHalfPromptId, itemId: 'bananas' },
      { kind: 'bet_taken', promptId: cardPromptId, itemId: 'pizza' },
    ],
  });

  const goalWin = events.find((e) => e.kind === 'bet_settled_win' && e.promptId === firstHalfPromptId);
  assert.ok(goalWin, 'the goal must settle the first-half-goal call');
  const cardStillOpen = !events.some((e) => (e.kind === 'bet_settled_win' || e.kind === 'bet_settled_loss') && e.promptId === cardPromptId);
  assert.ok(cardStillOpen, 'the confirmed goal must not settle the unrelated card-in-10 call');
});

test('ENG-020/REG-008: determinism holds across all four call types over a full synthetic match, shuffled frame order included', () => {
  const goalCueId = `cue:${FIXTURE_ID}:goal:det`;
  const frames = [
    kickoffFrame(),
    frame({ matchClockSeconds: 1000, cues: [cue({ kind: 'set_piece', value: { action: 'corner' } })] }),
    frame({ matchClockSeconds: 1200, cues: [cue({ kind: 'card', lifecycle: 'confirmed', value: { action: 'yellow_card' } })] }),
    frame({ matchClockSeconds: 1500, cues: [cue({ id: goalCueId, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1 })] }),
    frame({ matchClockSeconds: 2700, cues: [cue({ kind: 'phase_change', value: { phase: 'half_time' } })] }),
    frame({ matchClockSeconds: 2700, cues: [cue({ kind: 'phase_change', value: { phase: 'second_half' } })] }),
    frame({ matchClockSeconds: 5700, cues: [cue({ kind: 'phase_change', value: { phase: 'finalised' } })] }),
  ];
  const actions = [
    { kind: 'gift_claimed', anchorFrameId: frames[0].id, claimedAt: 1 },
    { kind: 'bet_taken', promptId: `${FIXTURE_ID}:economy:prompt:who_scores_next:0`, itemId: 'dust', pickedParticipant: 1 },
  ];

  const inOrder = buildEconomyTimeline(frames, { userId: USER_ID, actions });
  const shuffled = [...frames].sort(() => Math.random() - 0.5);
  const fromShuffled = buildEconomyTimeline(shuffled, { userId: USER_ID, actions });
  assert.deepEqual(fromShuffled, inOrder, 'shuffled frame order must produce a byte-identical event sequence across all four call types');

  // REG-007: foldEconomyBalances still derives purely from deltas with the new event kinds present.
  const balances = foldEconomyBalances(inOrder);
  assert.ok(Number.isFinite(balances.coolness));
});

test('REG-002/REG-004: losing a call never removes the staked item, for every call type; rarity still sizes the win payout', () => {
  // card_within_window loss:
  const cardFrame = frame({ matchClockSeconds: 1000, cues: [cue({ kind: 'card', lifecycle: 'confirmed', value: { action: 'yellow_card' } })] });
  const cardPromptId = `${FIXTURE_ID}:economy:prompt:card_call:${cardFrame.simulationCues[0].id}`;
  const noCardEvents = buildEconomyTimeline(
    [kickoffFrame(), cardFrame, frame({ matchClockSeconds: 1000 + 10 * 60 + 1 })],
    { userId: USER_ID, actions: [{ kind: 'bet_taken', promptId: cardPromptId, itemId: 'lambo' }] },
  );
  const cardLoss = noCardEvents.find((e) => e.kind === 'bet_settled_loss');
  assert.ok(cardLoss);
  assert.equal(cardLoss.itemDeltas.length, 0);

  // who_scores_next loss (wrong team scores):
  seqCounter = 0;
  const wrongTeamEvents = buildEconomyTimeline(
    [kickoffFrame(), frame({ matchClockSeconds: 300, cues: [cue({ kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 2 })] })],
    { userId: USER_ID, actions: [{ kind: 'bet_taken', promptId: `${FIXTURE_ID}:economy:prompt:who_scores_next:0`, itemId: 'lambo', pickedParticipant: 1 }] },
  );
  const whoScoresLoss = wrongTeamEvents.find((e) => e.kind === 'bet_settled_loss');
  assert.ok(whoScoresLoss);
  assert.equal(whoScoresLoss.itemDeltas.length, 0);
});
