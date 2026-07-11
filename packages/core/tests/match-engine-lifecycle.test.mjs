import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { replayMatchEngine } from '../src/match-engine/index.ts';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/txline-18179759-lifecycle.json', import.meta.url),
  'utf8',
));
const players = Object.fromEntries(Object.entries(fixture.players).map(([id, player]) => [
  id,
  { ...player, sourcePreferredName: player.name, displayName: player.name },
]));
const context = {
  ...fixture.fixture,
  confirmedScore: { participant1: 0, participant2: 0 },
  players,
};
const replay = (records = fixture.records) => replayMatchEngine(records, context);

test('sorts the 164-record lifecycle corpus into deterministic semantic frames', () => {
  const result = replay();
  assert.equal(result.ledger.length, 164);
  assert.equal(result.frames.length, 164);
  assert.deepEqual(result.ledger.map(({ Seq }) => Seq),
    [...fixture.records].map(({ Seq }) => Seq).sort((a, b) => a - b));
  assert.deepEqual(fixture.records.filter(({ Seq }) => Seq >= 768 && Seq <= 775).map(({ Seq }) => Seq),
    [768, 769, 770, 771, 773, 774, 772, 775]);
});

test('moves through regulation phases and preserves the playing clock across final reset', () => {
  const result = replay();
  const expected = new Map([
    [25, 'first_half_ready'], [28, 'first_half'], [428, 'half_time'],
    [432, 'second_half_ready'], [439, 'second_half'],
    [881, 'full_time_pending'], [885, 'finalised'],
  ]);
  for (const [seq, phase] of expected) {
    const fact = result.frames.find((frame) => frame.seq === seq)?.facts.find((item) => item.kind === 'phase');
    assert.equal(fact?.value.phase, phase, `phase at Seq ${seq}`);
  }
  assert.equal(result.state.phase, 'finalised');
  assert.equal(result.state.liveClock?.phase, 'finalised');
  assert.equal(result.state.lastPlayingElapsedSeconds, 5923);
  assert.equal(result.state.liveClock?.seconds, 0);
});

test('finishes 2-0 with two stable, player-enriched goals and two score commits', () => {
  const result = replay();
  const goals = Object.values(result.state.incidents).filter(({ action }) => action === 'goal');
  const commits = result.frames.flatMap(({ simulationCues }) =>
    simulationCues.filter(({ kind }) => kind === 'score_commit'));
  assert.deepEqual(result.state.confirmedScore, { participant1: 2, participant2: 0 });
  assert.deepEqual(result.state.finalScore, { participant1: 2, participant2: 0 });
  assert.equal(result.state.provisionalScore, undefined);
  assert.equal(goals.length, 2);
  assert.deepEqual(goals.map(({ sourceId, revision, lifecycle }) => [sourceId, revision, lifecycle]),
    [[207, 3, 'confirmed'], [247, 3, 'confirmed']]);
  assert.deepEqual(goals.map(({ player }) => player?.normativeId), [658987, 519204]);
  assert.equal(commits.length, 2);
});

test('reconciles substitutions and cards without duplicating late player revisions', () => {
  const result = replay();
  const incidents = Object.values(result.state.incidents);
  const substitutions = incidents.filter(({ action }) => action === 'substitution');
  const yellows = incidents.filter(({ action }) => action === 'yellow_card');
  const reds = incidents.filter(({ action }) => action === 'red_card');
  assert.equal(substitutions.length, 10);
  assert.equal(yellows.length, 3);
  assert.equal(reds.length, 1);
  assert.equal(yellows.every(({ lifecycle, player }) => lifecycle === 'confirmed' && player), true);
  assert.equal(reds[0].player?.normativeId, 10094733);
  assert.equal(result.state.activePlayerIdsByParticipant['1'].length, 11);
  assert.equal(result.state.activePlayerIdsByParticipant['2'].length, 10);
  assert.equal(Object.values(result.state.disciplineByPlayerId).reduce((sum, item) => sum + item.yellowCards, 0), 3);
  assert.equal(Object.values(result.state.disciplineByPlayerId).reduce((sum, item) => sum + item.redCards, 0), 1);
});

test('uses explicit VAR/discard rules without inferring unrelated incident links', () => {
  const result = replay();
  const review = result.state.incidents['18179759:var:736'];
  const red = result.state.incidents['18179759:red_card:738'];
  const discarded = result.state.incidents['18179759:throw_in:366'];
  assert.deepEqual(review.sourceSeqs, [837, 838, 840]);
  assert.equal(review.data.Outcome, 'Overturned');
  assert.notEqual(review.key, red.key);
  assert.equal(review.data.RedCardId, undefined);
  assert.equal(red.data.VarId, undefined);
  assert.equal(discarded.lifecycle, 'retracted');
  assert.deepEqual(discarded.sourceSeqs, [406, 407]);
  assert.equal(Object.values(result.state.possibleEvents).flatMap(Object.values).some(Boolean), false);
});

test('is idempotent and resolves conflicting same-sequence payloads independent of input order', () => {
  const baseline = replay();
  const duplicated = replay([...fixture.records].reverse().concat(fixture.records));
  assert.equal(duplicated.ignoredDuplicateCount, 164);
  assert.deepEqual(duplicated.state, baseline.state);
  assert.deepEqual(duplicated.frames, baseline.frames);

  const original = fixture.records.find(({ Seq }) => Seq === 395);
  const conflict = { ...original, Data: { SyntheticConflict: true } };
  const left = replay([original, conflict]);
  const right = replay([conflict, original]);
  assert.deepEqual(left.state, right.state);
  assert.deepEqual(left.frames, right.frames);
  assert.equal(left.state.integrityWarnings.some((warning) => warning.includes('deterministic canonical payload')), true);
});
