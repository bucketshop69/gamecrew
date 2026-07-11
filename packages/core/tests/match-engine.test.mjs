import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { replayMatchEngine } from '../src/match-engine/index.ts';

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/txline-18179759-seq-209-234.json', import.meta.url),
    'utf8',
  ),
);

const records = fixture.records;
const context = {
  fixtureId: fixture.fixture.fixtureId,
  sequenceBefore: fixture.baseline.sequenceBefore,
  participants: fixture.fixture.participants,
  confirmedScore: fixture.baseline.confirmedScore,
  players: fixture.players,
};

function replayThrough(seq) {
  return replayMatchEngine(records.filter((record) => record.Seq <= seq), context);
}

function frameAt(result, seq) {
  const frame = result.frames.find((candidate) => candidate.seq === seq);
  assert.ok(frame, `expected a semantic frame for Seq ${seq}`);
  return frame;
}

function incidentFact(frame, action, sourceId) {
  const fact = frame.facts.find(
    (candidate) => candidate.kind === 'incident'
      && candidate.value.action === action
      && candidate.value.sourceId === sourceId,
  );
  assert.ok(fact, `expected ${action} ${sourceId} fact in Seq ${frame.seq}`);
  return fact;
}

test('replays all 26 source sequences into one deterministic frame each', () => {
  const result = replayMatchEngine(records, context);

  assert.equal(records.length, 26);
  assert.equal(result.ledger.length, 26);
  assert.equal(result.frames.length, 26);
  assert.deepEqual(result.ledger.map((record) => record.Seq),
    Array.from({ length: 26 }, (_, index) => 209 + index));
  assert.deepEqual(result.frames.map((frame) => frame.seq),
    Array.from({ length: 26 }, (_, index) => 209 + index));
});

test('goal 207 advances provisional to confirmed to player-enriched without duplication', () => {
  const result = replayMatchEngine(records, context);
  const goalKey = '18179759:goal:207';
  const canonicalGoals = Object.values(result.state.incidents)
    .filter((incident) => incident.action === 'goal');

  assert.equal(canonicalGoals.length, 1);
  assert.equal(canonicalGoals[0].key, goalKey);
  assert.equal(canonicalGoals[0].revision, 3);
  assert.equal(canonicalGoals[0].lifecycle, 'confirmed');
  assert.deepEqual(canonicalGoals[0].sourceSeqs, [218, 219, 221]);
  assert.equal(canonicalGoals[0].player?.normativeId, 658987);
  assert.equal(canonicalGoals[0].player?.displayName, 'Julián Quiñones');

  const provisional = incidentFact(frameAt(result, 218), 'goal', 207);
  const confirmed = incidentFact(frameAt(result, 219), 'goal', 207);
  const enriched = incidentFact(frameAt(result, 221), 'goal', 207);

  assert.equal(provisional.id, confirmed.id);
  assert.equal(confirmed.id, enriched.id);
  assert.equal(provisional.lifecycle, 'provisional');
  assert.equal(confirmed.lifecycle, 'confirmed');
  assert.equal(enriched.lifecycle, 'confirmed');
  assert.equal(provisional.player, undefined);
  assert.equal(confirmed.player, undefined);
  assert.equal(enriched.player?.normativeId, 658987);

  assert.equal(frameAt(result, 218).simulationCues
    .some((cue) => cue.kind === 'goal_pending'), true);
  assert.equal(frameAt(result, 219).simulationCues
    .some((cue) => cue.kind === 'goal_confirmed'), true);
  assert.equal(frameAt(result, 221).simulationCues
    .some((cue) => cue.kind === 'player_highlight'), true);
});

test('commits the confirmed 1-0 score exactly once', () => {
  const result = replayMatchEngine(records, context);
  const beforeConfirmation = replayThrough(218);
  const atConfirmation = replayThrough(219);
  const scoreCommits = result.frames.flatMap((frame) =>
    frame.simulationCues
      .filter((cue) => cue.kind === 'score_commit')
      .map((cue) => ({ seq: frame.seq, cue })),
  );

  assert.deepEqual(beforeConfirmation.state.confirmedScore,
    { participant1: 0, participant2: 0 });
  assert.deepEqual(beforeConfirmation.state.provisionalScore,
    { participant1: 1, participant2: 0 });
  assert.deepEqual(atConfirmation.state.confirmedScore,
    { participant1: 1, participant2: 0 });
  assert.equal(atConfirmation.state.provisionalScore, undefined);
  assert.deepEqual(result.state.confirmedScore,
    { participant1: 1, participant2: 0 });
  assert.equal(scoreCommits.length, 1);
  assert.equal(scoreCommits[0].seq, 219);
  assert.deepEqual(scoreCommits[0].cue.value,
    { participant1: 1, participant2: 0 });
});

test('keeps shot 206 separate and never infers a shooter or goal relationship', () => {
  const result = replayMatchEngine(records, context);
  const shot = result.state.incidents['18179759:shot:206'];
  const goal = result.state.incidents['18179759:goal:207'];
  const shotFact = result.state.supportedFacts['fact:18179759:shot:206'];

  assert.ok(shot);
  assert.ok(goal);
  assert.notEqual(shot.key, goal.key);
  assert.deepEqual(shot.sourceSeqs, [217, 223]);
  assert.equal(shot.revision, 2);
  assert.equal(shot.lifecycle, 'confirmed');
  assert.equal(shot.data.Outcome, 'OnTarget');
  assert.equal(shot.data.PlayerId, undefined);
  assert.equal(shot.data.GoalId, undefined);
  assert.equal(shot.player, undefined);
  assert.equal(shotFact.player, undefined);
  assert.equal(shotFact.value.PlayerId, undefined);
  assert.equal(shotFact.value.GoalId, undefined);
  assert.equal(frameAt(result, 223).simulationCues
    .some((cue) => cue.kind === 'shot_outcome'), true);
});

test('treats possession records without Confirmed as observed direct facts and probable cues', () => {
  const source = records.find((record) => record.Seq === 216);
  const result = replayMatchEngine(records, context);
  const frame = frameAt(result, 216);
  const fact = frame.facts.find((candidate) => candidate.kind === 'possession');
  const cue = frame.simulationCues.find((candidate) => candidate.kind === 'possession_pressure');

  assert.equal(source.Confirmed, undefined);
  assert.ok(fact);
  assert.ok(cue);
  assert.equal(fact.lifecycle, 'observed');
  assert.equal(fact.basis, 'direct');
  assert.equal(fact.value.pressure, 'high_danger');
  assert.equal(cue.lifecycle, 'observed');
  assert.equal(cue.basis, 'derived_probable');
  assert.equal(cue.pressure, 'high_danger');
  assert.equal(cue.probableZone, 'high_danger');
  assert.deepEqual(cue.derivation, {
    ruleId: 'txline-possession-pressure-to-probable-zone',
    ruleVersion: 1,
    inputFactIds: [fact.id],
  });
});

test('keeps owner-only possession direct without inventing a neutral zone', () => {
  const source = records.find((record) => record.Seq === 231);
  const result = replayMatchEngine(records, context);
  const frame = frameAt(result, 231);
  const fact = frame.facts.find((candidate) => candidate.kind === 'possession');
  const cue = frame.simulationCues.find((candidate) => candidate.kind === 'possession_change');

  assert.equal(source.PossessionType, undefined);
  assert.ok(fact);
  assert.deepEqual(fact.value, { owner: 1 });
  assert.equal(fact.basis, 'direct');
  assert.ok(cue);
  assert.equal(cue.basis, 'direct');
  assert.equal(cue.pressure, undefined);
  assert.equal(cue.probableZone, undefined);
  assert.equal(cue.derivation, undefined);
});

test('late shot detail at Seq 223 does not regress the meaningful match clock', () => {
  const throughStandby = replayThrough(222);
  const throughLateShot = replayThrough(223);

  assert.equal(frameAt(throughLateShot, 223).matchClockSeconds, 1275);
  assert.equal(throughStandby.state.lastMeaningfulElapsedSeconds, 1276);
  assert.equal(throughLateShot.state.lastMeaningfulElapsedSeconds, 1276);
});

test('orders shuffled input, ignores exact duplicates, and reaches identical canonical state', () => {
  const baseline = replayMatchEngine(records, context);
  const reversedWithExactDuplicates = [...records].reverse().concat(records);
  const replayed = replayMatchEngine(reversedWithExactDuplicates, context);

  assert.equal(replayed.ignoredDuplicateCount, 26);
  assert.equal(replayed.ledger.length, 26);
  assert.equal(replayed.frames.length, 26);
  assert.deepEqual(replayed.ledger.map((record) => record.Seq),
    baseline.ledger.map((record) => record.Seq));
  assert.deepEqual(replayed.state, baseline.state);
  assert.deepEqual(replayed.frames, baseline.frames);
});
