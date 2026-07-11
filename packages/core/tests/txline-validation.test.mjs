import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitTxlineMatchPulseMoments,
  buildTxlineMatchPulseSourceContext,
  txlineMatchPulseLlmMomentJsonSchema,
  validateTxlineMatchPulseMoment,
  validateTxlineMatchPulseMoments,
} from '../src/txline.ts';

const baseFixture = {
  Ts: Date.parse('2026-07-06T00:00:00.000Z'),
  StartTime: Date.parse('2026-07-06T01:00:00.000Z'),
  Competition: 'World Cup',
  CompetitionId: 72,
  FixtureGroupId: 10115574,
  Participant1Id: 1,
  Participant1: 'Mexico',
  Participant2Id: 2,
  Participant2: 'England',
  FixtureId: 18192996,
  Participant1IsHome: true,
};

test('validation accepts a source-backed LLM rewrite and patches source-owned fields', () => {
  const { context, fallback } = getPressureFixture();
  const candidate = {
    ...fallback,
    title: 'Mexico keep England pinned in',
    body: 'Mexico turn late pressure into shots and corners while trailing 2-3.',
    generation: 'llm',
    clock: { seconds: 9999, minute: 167, label: '167\'' },
  };

  const result = validateTxlineMatchPulseMoment(context, candidate, { fallbackMoment: fallback });

  assert.equal(result.report.valid, true);
  assert.equal(result.report.fallbackUsed, false);
  assert.equal(result.moment.generation, 'llm');
  assert.equal(result.moment.clock.label, fallback.clock.label);
  assert.deepEqual(result.moment.scoreAtMoment, { home: 2, away: 3 });
});

test('validation rejects score and clock mismatch and returns deterministic fallback', () => {
  const { context, fallback } = getPressureFixture();
  const candidate = {
    ...fallback,
    title: 'Mexico pile on pressure',
    body: 'Mexico are pushing hard.',
    generation: 'llm',
    scoreAtMoment: { home: 9, away: 3 },
    clock: { seconds: 1, minute: 1, label: '1\'' },
  };

  const result = validateTxlineMatchPulseMoment(context, candidate, { fallbackMoment: fallback });

  assert.equal(result.report.valid, false);
  assert.equal(result.report.fallbackUsed, true);
  assert.equal(result.moment.generation, 'rule_based');
  assert.equal(result.moment.title, fallback.fallbackTitle);
  assert.equal(result.moment.body, fallback.fallbackBody);
  assert.deepEqual(result.moment.scoreAtMoment, fallback.scoreAtMoment);
  assert.deepEqual(issueCodes(result), ['clock_mismatch', 'score_mismatch']);
});

test('validation rejects missing source ids', () => {
  const { context, fallback } = getPressureFixture();
  const candidate = {
    ...fallback,
    generation: 'llm',
    sourceEvents: [{ kind: 'txline_update', fixtureId: context.fixture.fixtureId }],
  };

  const result = validateTxlineMatchPulseMoment(context, candidate, { fallbackMoment: fallback });

  assert.equal(result.report.valid, false);
  assert.equal(result.report.fallbackUsed, true);
  assert.equal(issueCodes(result).includes('missing_source'), true);
});

test('validation rejects unsupported betting, formation, player, and ball-location claims', () => {
  const { context, fallback } = getPressureFixture();
  const candidate = {
    ...fallback,
    title: 'Mexico move into a 4-3-3',
    body: 'The striker is value on the odds market as the ball rolls into the box.',
    voiceLine: 'Betting momentum is with Mexico.',
    generation: 'llm',
  };

  const result = validateTxlineMatchPulseMoment(context, candidate, { fallbackMoment: fallback });

  assert.equal(result.report.valid, false);
  assert.equal(result.report.fallbackUsed, true);
  assert.equal(issueCodes(result).filter((code) => code === 'unsupported_claim').length, 4);
});

test('validation rejects type/team mismatch against source events', () => {
  const { context, fallback } = getPressureFixture();
  const candidate = {
    ...fallback,
    type: 'goal',
    team: {
      id: 'txline-team-2',
      name: 'England',
      shortName: 'ENG',
      side: 'away',
    },
    generation: 'llm',
  };

  const result = validateTxlineMatchPulseMoment(context, candidate, { fallbackMoment: fallback });

  assert.equal(result.report.valid, false);
  assert.equal(result.report.fallbackUsed, true);
  assert.equal(issueCodes(result).includes('type_mismatch'), true);
  assert.equal(issueCodes(result).includes('team_mismatch'), true);
});

test('validation batch exposes reports and fallback-safe moments', () => {
  const { context, fallback } = getPressureFixture();
  const validCandidate = {
    ...fallback,
    generation: 'llm',
    body: 'Mexico generate a late sequence of pressure.',
  };
  const invalidCandidate = {
    ...fallback,
    id: `${fallback.id}-bad`,
    generation: 'llm',
    body: '',
  };

  const result = validateTxlineMatchPulseMoments(context, [validCandidate, invalidCandidate], [fallback, fallback]);

  assert.equal(result.moments.length, 2);
  assert.equal(result.reports.length, 2);
  assert.equal(result.reports[0].fallbackUsed, false);
  assert.equal(result.reports[1].fallbackUsed, true);
  assert.equal(result.moments[1].generation, 'rule_based');
});

test('LLM moment JSON schema requires source events and fallback copy', () => {
  assert.equal(txlineMatchPulseLlmMomentJsonSchema.properties.sourceEvents.minItems, 1);
  assert.equal(txlineMatchPulseLlmMomentJsonSchema.properties.generation.const, 'llm');
  assert.equal(txlineMatchPulseLlmMomentJsonSchema.required.includes('fallbackTitle'), true);
});

function getPressureFixture() {
  const context = buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    updateScores: [
      txScore({ id: 'danger-1', seq: 20, action: 'high_danger_possession', seconds: 6060, participant: 1, confirmed: true }),
      txScore({ id: 'shot-1', seq: 21, action: 'shot', seconds: 6070, participant: 1, confirmed: true }),
      txScore({ id: 'corner-1', seq: 22, action: 'corner', seconds: 6080, participant: 1, confirmed: true }),
    ],
  });
  const [fallback] = admitTxlineMatchPulseMoments(context);

  return { context, fallback };
}

function txScore({
  id,
  seq,
  action,
  seconds,
  participant,
  confirmed,
  home = 2,
  away = 3,
}) {
  return {
    Id: id,
    Seq: seq,
    Ts: Date.parse('2026-07-06T03:00:00.000Z') + seq * 1000,
    Action: action,
    Clock: { Seconds: seconds },
    Participant: participant,
    Confirmed: confirmed,
    Stats: { 1: home, 2: away },
  };
}

function issueCodes(result) {
  return result.report.issues.map((issue) => issue.code).sort();
}
