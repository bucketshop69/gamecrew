import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeGoalSequenceBeatIndex,
  escalationLabel,
  formatPlayerDisplayName,
  formatScoreline,
  phaseBreakLabel,
  planGoalSequenceBeats,
  playerDisplayName,
  reduceMotionHoldMs,
  resolveCardVariant,
  resolvePhaseBreakMoment,
  resolveSetPieceVariant,
  resolveTakeoverComponentKind,
  selectGoalSequenceEscalation,
  setPieceLabel,
  totalGoalSequenceDurationMs,
} from '../src/screens/game-view-takeovers/game-view-takeover-logic.ts';

// ---------------------------------------------------------------------------
// Player display name
// ---------------------------------------------------------------------------

test('formatPlayerDisplayName leaves already-ordered names alone', () => {
  assert.equal(formatPlayerDisplayName('Lionel Messi'), 'Lionel Messi');
});

test('formatPlayerDisplayName reorders "Surname, Given" to "Given Surname"', () => {
  assert.equal(formatPlayerDisplayName('Messi, Lionel'), 'Lionel Messi');
});

test('formatPlayerDisplayName dedupes an adjacent repeated token within one name part', () => {
  assert.equal(formatPlayerDisplayName('Lionel Lionel Messi'), 'Lionel Messi');
});

test('formatPlayerDisplayName trims whitespace', () => {
  assert.equal(formatPlayerDisplayName('  Raúl   Jiménez  '), 'Raúl Jiménez');
});

test('formatPlayerDisplayName returns undefined for missing/empty input', () => {
  assert.equal(formatPlayerDisplayName(undefined), undefined);
  assert.equal(formatPlayerDisplayName(''), undefined);
  assert.equal(formatPlayerDisplayName('   '), undefined);
});

test('playerDisplayName prefers displayName over sourcePreferredName', () => {
  assert.equal(
    playerDisplayName({ displayName: 'Lionel Messi', sourcePreferredName: 'Messi, Lionel' }),
    'Lionel Messi',
  );
});

test('playerDisplayName falls back to sourcePreferredName, humanized', () => {
  assert.equal(
    playerDisplayName({ sourcePreferredName: 'Jiménez, Raúl' }),
    'Raúl Jiménez',
  );
});

test('playerDisplayName returns undefined when no player is present', () => {
  assert.equal(playerDisplayName(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Scoreline formatting
// ---------------------------------------------------------------------------

test('formatScoreline formats participant1-participant2', () => {
  assert.equal(formatScoreline({ participant1: 2, participant2: 1 }), '2-1');
});

test('formatScoreline handles a nil-nil score', () => {
  assert.equal(formatScoreline({ participant1: 0, participant2: 0 }), '0-0');
});

test('formatScoreline returns empty string for an undefined score', () => {
  assert.equal(formatScoreline(undefined), '');
});

// ---------------------------------------------------------------------------
// Goal sequence beat planning
// ---------------------------------------------------------------------------

function goalSequenceScene(beats, durationHint = { minMs: 4000, maxMs: 8000 }) {
  return {
    id: 'scene-1',
    fixtureId: 'fx-1',
    kind: 'goal_sequence',
    startRevision: 1,
    sourceFrameIds: ['f1'],
    durationHint,
    beats,
  };
}

test('planGoalSequenceBeats returns an empty plan for a beat-less scene', () => {
  assert.deepEqual(planGoalSequenceBeats(goalSequenceScene(undefined)), []);
  assert.deepEqual(planGoalSequenceBeats(goalSequenceScene([])), []);
});

test('planGoalSequenceBeats gives a single beat the full duration', () => {
  const tension = { kind: 'tension', lifecycle: 'provisional', sourceFrameIds: ['f1'] };
  const plan = planGoalSequenceBeats(goalSequenceScene([tension]));
  assert.equal(plan.length, 1);
  assert.equal(plan[0].offsetMs, 0);
  assert.equal(plan[0].durationMs, 4000);
});

test('planGoalSequenceBeats weights celebration longer than tension and tiles beats back-to-back', () => {
  const tension = { kind: 'tension', lifecycle: 'provisional', sourceFrameIds: ['f1'] };
  const celebration = { kind: 'celebration', lifecycle: 'confirmed', sourceFrameIds: ['f2'] };
  const plan = planGoalSequenceBeats(goalSequenceScene([tension, celebration]));

  assert.equal(plan.length, 2);
  assert.equal(plan[0].offsetMs, 0);
  assert.equal(plan[1].offsetMs, plan[0].durationMs);
  assert.ok(plan[1].durationMs > plan[0].durationMs, 'celebration should hold longer than tension');
  assert.equal(totalGoalSequenceDurationMs(plan), plan[0].durationMs + plan[1].durationMs);
});

test('planGoalSequenceBeats enforces a minimum readable hold per beat even with a tiny durationHint', () => {
  const tension = { kind: 'tension', lifecycle: 'provisional', sourceFrameIds: ['f1'] };
  const celebration = { kind: 'celebration', lifecycle: 'confirmed', sourceFrameIds: ['f2'] };
  const plan = planGoalSequenceBeats(goalSequenceScene([tension, celebration], { minMs: 100, maxMs: 200 }));
  assert.ok(plan[0].durationMs >= 1200);
  assert.ok(plan[1].durationMs >= 1200);
});

test('totalGoalSequenceDurationMs returns 0 for an empty plan', () => {
  assert.equal(totalGoalSequenceDurationMs([]), 0);
});

// ---------------------------------------------------------------------------
// Active beat resolution (fix #3: no score spoiler)
// ---------------------------------------------------------------------------

test('activeGoalSequenceBeatIndex returns 0 for an empty plan', () => {
  assert.equal(activeGoalSequenceBeatIndex([], 0), 0);
  assert.equal(activeGoalSequenceBeatIndex([], 5000), 0);
});

test('activeGoalSequenceBeatIndex returns the first beat at elapsed 0', () => {
  const tension = { kind: 'tension', lifecycle: 'provisional', sourceFrameIds: ['f1'] };
  const celebration = { kind: 'celebration', lifecycle: 'confirmed', sourceFrameIds: ['f2'] };
  const plan = planGoalSequenceBeats(goalSequenceScene([tension, celebration]));
  assert.equal(activeGoalSequenceBeatIndex(plan, 0), 0);
});

test('activeGoalSequenceBeatIndex stays on the tension beat until the celebration beat\'s offset is reached', () => {
  const tension = { kind: 'tension', lifecycle: 'provisional', sourceFrameIds: ['f1'] };
  const celebration = { kind: 'celebration', lifecycle: 'confirmed', sourceFrameIds: ['f2'] };
  const plan = planGoalSequenceBeats(goalSequenceScene([tension, celebration]));
  const celebrationOffset = plan[1].offsetMs;

  assert.equal(activeGoalSequenceBeatIndex(plan, celebrationOffset - 1), 0);
  assert.equal(activeGoalSequenceBeatIndex(plan, celebrationOffset), 1);
  assert.equal(activeGoalSequenceBeatIndex(plan, celebrationOffset + 500), 1);
});

test('activeGoalSequenceBeatIndex clamps to the last beat once elapsed exceeds the whole plan', () => {
  const tension = { kind: 'tension', lifecycle: 'provisional', sourceFrameIds: ['f1'] };
  const celebration = { kind: 'celebration', lifecycle: 'confirmed', sourceFrameIds: ['f2'] };
  const plan = planGoalSequenceBeats(goalSequenceScene([tension, celebration]));
  assert.equal(activeGoalSequenceBeatIndex(plan, totalGoalSequenceDurationMs(plan) + 10_000), 1);
});

// ---------------------------------------------------------------------------
// Escalation selection (comeback / late_winner)
// ---------------------------------------------------------------------------

test('selectGoalSequenceEscalation returns undefined when scoreEvents is empty or missing', () => {
  assert.equal(selectGoalSequenceEscalation(undefined), undefined);
  assert.equal(selectGoalSequenceEscalation([]), undefined);
});

test('selectGoalSequenceEscalation returns undefined for an ordinary opener/extends_lead', () => {
  assert.equal(selectGoalSequenceEscalation(['opener']), undefined);
  assert.equal(selectGoalSequenceEscalation(['extends_lead']), undefined);
  assert.equal(selectGoalSequenceEscalation(['equaliser', 'lead_change']), undefined);
});

test('selectGoalSequenceEscalation surfaces comeback', () => {
  assert.equal(selectGoalSequenceEscalation(['comeback', 'lead_change']), 'comeback');
});

test('selectGoalSequenceEscalation surfaces late_winner', () => {
  assert.equal(selectGoalSequenceEscalation(['late_winner']), 'late_winner');
});

test('selectGoalSequenceEscalation prefers comeback over late_winner when both are present', () => {
  assert.equal(selectGoalSequenceEscalation(['late_winner', 'comeback']), 'comeback');
});

test('selectGoalSequenceEscalation never invents an escalation not present in scoreEvents', () => {
  assert.equal(selectGoalSequenceEscalation(['opener', 'extends_lead']), undefined);
});

test('escalationLabel maps escalations to display copy', () => {
  assert.equal(escalationLabel('comeback'), 'COMEBACK');
  assert.equal(escalationLabel('late_winner'), 'LATE WINNER');
  assert.equal(escalationLabel(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Card variant resolution
// ---------------------------------------------------------------------------

test('resolveCardVariant passes through red', () => {
  assert.equal(resolveCardVariant('red'), 'red');
});

test('resolveCardVariant passes through yellow', () => {
  assert.equal(resolveCardVariant('yellow'), 'yellow');
});

test('resolveCardVariant defaults to yellow for missing/unrecognized input', () => {
  assert.equal(resolveCardVariant(undefined), 'yellow');
  assert.equal(resolveCardVariant('mystery'), 'yellow');
});

// ---------------------------------------------------------------------------
// Set-piece variant resolution
// ---------------------------------------------------------------------------

test('resolveSetPieceVariant passes through known variants', () => {
  assert.equal(resolveSetPieceVariant('corner'), 'corner');
  assert.equal(resolveSetPieceVariant('throw_in'), 'throw_in');
  assert.equal(resolveSetPieceVariant('penalty'), 'penalty');
  assert.equal(resolveSetPieceVariant('free_kick'), 'free_kick');
});

test('resolveSetPieceVariant defaults to free_kick for missing/unrecognized input', () => {
  assert.equal(resolveSetPieceVariant(undefined), 'free_kick');
  assert.equal(resolveSetPieceVariant('mystery'), 'free_kick');
});

test('setPieceLabel returns display copy for each variant', () => {
  assert.equal(setPieceLabel('corner'), 'CORNER');
  assert.equal(setPieceLabel('free_kick'), 'FREE KICK');
  assert.equal(setPieceLabel('throw_in'), 'THROW-IN');
  assert.equal(setPieceLabel('penalty'), 'PENALTY');
});

// ---------------------------------------------------------------------------
// Phase break labeling
// ---------------------------------------------------------------------------

test('resolvePhaseBreakMoment maps kickoff-adjacent phases', () => {
  assert.equal(resolvePhaseBreakMoment('pre_match'), 'kickoff');
  assert.equal(resolvePhaseBreakMoment('first_half_ready'), 'kickoff');
  assert.equal(resolvePhaseBreakMoment('first_half'), 'kickoff');
});

test('resolvePhaseBreakMoment maps half-time-adjacent phases', () => {
  assert.equal(resolvePhaseBreakMoment('half_time'), 'half_time');
  assert.equal(resolvePhaseBreakMoment('second_half_ready'), 'half_time');
});

test('resolvePhaseBreakMoment maps full-time-adjacent phases', () => {
  assert.equal(resolvePhaseBreakMoment('full_time_pending'), 'full_time');
  assert.equal(resolvePhaseBreakMoment('finalised'), 'full_time');
});

test('resolvePhaseBreakMoment falls back to other for unmapped/missing phase', () => {
  assert.equal(resolvePhaseBreakMoment('second_half'), 'other');
  assert.equal(resolvePhaseBreakMoment(undefined), 'other');
});

test('phaseBreakLabel returns display copy for each moment', () => {
  assert.equal(phaseBreakLabel('kickoff'), 'KICK OFF');
  assert.equal(phaseBreakLabel('half_time'), 'HALF TIME');
  assert.equal(phaseBreakLabel('full_time'), 'FULL TIME');
  assert.equal(phaseBreakLabel('extra_time'), 'EXTRA TIME');
  assert.equal(phaseBreakLabel('other'), 'MATCH UPDATE');
});

// ---------------------------------------------------------------------------
// Dispatcher mapping
// ---------------------------------------------------------------------------

test('resolveTakeoverComponentKind maps every takeover-eligible scene kind', () => {
  assert.equal(resolveTakeoverComponentKind('goal_sequence'), 'goal_sequence');
  assert.equal(resolveTakeoverComponentKind('card'), 'card');
  assert.equal(resolveTakeoverComponentKind('set_piece'), 'set_piece');
  assert.equal(resolveTakeoverComponentKind('var_review'), 'var_review');
  assert.equal(resolveTakeoverComponentKind('goal_retracted'), 'goal_retracted');
  assert.equal(resolveTakeoverComponentKind('phase_break'), 'phase_break');
  assert.equal(resolveTakeoverComponentKind('restart'), 'restart');
});

test('resolveTakeoverComponentKind returns none for non-takeover scene kinds', () => {
  assert.equal(resolveTakeoverComponentKind('ambient'), 'none');
  assert.equal(resolveTakeoverComponentKind('shot'), 'none');
  assert.equal(resolveTakeoverComponentKind('substitution'), 'none');
});

// ---------------------------------------------------------------------------
// Reduce-motion hold duration
// ---------------------------------------------------------------------------

test('reduceMotionHoldMs uses the scene duration hint when it clears the minimum', () => {
  assert.equal(reduceMotionHoldMs(3000), 3000);
});

test('reduceMotionHoldMs enforces a floor for a tiny or missing duration hint', () => {
  assert.equal(reduceMotionHoldMs(100), 1200);
  assert.equal(reduceMotionHoldMs(undefined), 1200);
});
