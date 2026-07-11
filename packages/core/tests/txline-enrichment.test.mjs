import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitTxlineMatchPulseMoments,
  applyTxlineMatchPulseLlmJson,
  buildTxlineMatchPulseEnrichmentInput,
  buildTxlineMatchPulseEnrichmentPrompt,
  buildTxlineMatchPulseSourceContext,
  parseTxlineMatchPulseLlmJson,
  validateTxlineMatchPulseMoment,
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

test('enrichment input is bounded to fixture, fallback moment, and source facts', () => {
  const { context, moment } = getFixtureMoment();

  const input = buildTxlineMatchPulseEnrichmentInput(context, moment);

  assert.equal(input.fixture.matchup, 'Mexico vs England');
  assert.equal(input.moment.id, moment.id);
  assert.equal(input.moment.fallbackTitle, moment.fallbackTitle);
  assert.equal(input.sourceFacts.length, moment.sourceEvents.length);
  assert.equal(input.sourceFacts[0].team, 'Mexico');
  assert.equal(input.constraints.some((constraint) => constraint.includes('Do not mention odds')), true);
});

test('enrichment prompt asks for JSON-only commentator output', () => {
  const { context, moment } = getFixtureMoment();

  const prompt = buildTxlineMatchPulseEnrichmentPrompt(context, moment);

  assert.equal(prompt.messages.length, 2);
  assert.equal(prompt.messages[0].role, 'system');
  assert.match(prompt.messages[0].content, /Return only valid JSON/);
  assert.equal(prompt.messages[1].role, 'user');
});

test('LLM JSON parser extracts fenced or prefixed JSON content', () => {
  const parsed = parseTxlineMatchPulseLlmJson([
    'Sure:',
    '{"title":"Mexico turn up pressure","body":"Mexico force shots and corners while chasing 2-3.","voiceLine":"Mexico are asking questions now."}',
  ].join('\n'));

  assert.equal(parsed.title, 'Mexico turn up pressure');
  assert.equal(parsed.voiceLine, 'Mexico are asking questions now.');
});

test('LLM JSON applies to fallback moment and still passes validator', () => {
  const { context, moment } = getFixtureMoment();
  const candidate = applyTxlineMatchPulseLlmJson(moment, {
    title: 'Mexico turn up pressure',
    body: 'Mexico force shots and corners while chasing the match at 2-3.',
    voiceLine: 'Mexico are piling it on now.',
  });

  const result = validateTxlineMatchPulseMoment(context, candidate, { fallbackMoment: moment });

  assert.equal(candidate.generation, 'llm');
  assert.equal(result.report.valid, true);
  assert.equal(result.moment.title, 'Mexico turn up pressure');
});

test('LLM rewrite cannot downgrade a confirmed goal moment to generic commentary', () => {
  const { context, moment } = getGoalMoment();
  const candidate = applyTxlineMatchPulseLlmJson(moment, {
    title: 'Mexico finish the move',
    body: 'Mexico strike after the build-up at 83\'.',
    type: 'commentary',
  });

  const result = validateTxlineMatchPulseMoment(context, candidate, { fallbackMoment: moment });

  assert.equal(result.report.valid, false);
  assert.equal(result.report.fallbackUsed, true);
  assert.equal(result.moment.type, 'goal');
  assert.equal(result.moment.sourceEvents[0].action, 'goal');
  assert.equal(result.moment.generation, 'rule_based');
});

function getFixtureMoment() {
  const context = buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    updateScores: [
      txScore({ id: 'danger-1', seq: 20, action: 'high_danger_possession', seconds: 6060, participant: 1, confirmed: true }),
      txScore({ id: 'shot-1', seq: 21, action: 'shot', seconds: 6070, participant: 1, confirmed: true }),
      txScore({ id: 'corner-1', seq: 22, action: 'corner', seconds: 6080, participant: 1, confirmed: true }),
    ],
  });
  const [moment] = admitTxlineMatchPulseMoments(context);

  return { context, moment };
}

function getGoalMoment() {
  const context = buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    updateScores: [
      txScore({
        id: 'goal-1',
        seq: 30,
        action: 'goal',
        seconds: 5020,
        participant: 1,
        confirmed: true,
        home: 3,
        away: 3,
      }),
    ],
  });
  const [moment] = admitTxlineMatchPulseMoments(context);

  return { context, moment };
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
