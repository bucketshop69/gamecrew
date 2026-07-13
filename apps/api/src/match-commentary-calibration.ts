import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  planCommentaryBeats,
  type MatchEnginePhase,
  type SemanticFrame,
} from '@gamecrew/core';
import { loadConfig } from './config.js';
import { commentaryEntryFromBeat } from './ingestion/commentary-projection-consumer.js';
import { SqliteIngestionStore } from './ingestion/sqlite-ingestion-store.js';
import { createMatchPulseEnrichmentService } from './match-pulse-llm.js';

const fixtureId = process.argv.find((value) => /^\d+$/.test(value)) ?? '18179759';
const databasePath = process.argv.find((value) => value.endsWith('.sqlite'))
  ?? resolve(process.cwd(), `.data/match-ingestion-${fixtureId}.sqlite`);
const selectedCases = [
  { label: 'kickoff', fromSeq: 28 },
  { label: 'pressure', fromSeq: 38 },
  { label: 'goal', fromSeq: 219 },
  { label: 'post_goal_restart', fromSeq: 224 },
  { label: 'half_time', fromSeq: 428 },
  { label: 'second_half_kickoff', fromSeq: 439 },
  { label: 'red_card', fromSeq: 842 },
  { label: 'full_time', fromSeq: 885 },
] as const;
const requestedLabels = new Set(
  (process.argv.find((value) => value.startsWith('--cases='))?.slice('--cases='.length) ?? '')
    .split(',')
    .filter(Boolean),
);
const calibrationCases = requestedLabels.size > 0
  ? selectedCases.filter(({ label }) => requestedLabels.has(label))
  : selectedCases;
assert.ok(calibrationCases.length > 0, 'No known calibration cases matched --cases.');

const config = loadConfig();
assert.equal(config.llmEnabled, true, 'Live commentary calibration requires MATCH_PULSE_LLM_ENABLED=1.');
assert.ok(config.llmBaseUrl, 'Live commentary calibration requires MATCH_PULSE_LLM_BASE_URL.');
const store = new SqliteIngestionStore(databasePath);

try {
  const checkpoint = await store.getCheckpoint(fixtureId);
  assert.ok(checkpoint, `No engine checkpoint for fixture ${fixtureId}. Run ingestion:smoke first.`);
  const fixtureContext = await store.getFixtureContext(fixtureId);
  assert.ok(fixtureContext?.participants.length, `No persisted fixture participants for ${fixtureId}.`);
  const teams = fixtureContext.participants;
  const storedFrames = await store.listFramesAfter(fixtureId, 0, checkpoint.engineVersion);
  const frames = storedFrames.map(({ frame }) => frame);
  const phases = phasesByFrame(frames);
  const beats = planCommentaryBeats(frames, {
    projectionGeneration: checkpoint.projectionGeneration,
    teams,
  });
  const selected = calibrationCases.map((calibrationCase) => {
    const beat = beats.find((candidate) => candidate.fromSeq === calibrationCase.fromSeq);
    assert.ok(beat, `Missing ${calibrationCase.label} beat at Seq ${calibrationCase.fromSeq}.`);
    return {
      ...calibrationCase,
      entry: commentaryEntryFromBeat(
        beat,
        phases.get(beat.sourceFrameIds[0] ?? '') ?? checkpoint.phase,
        teams,
      ),
    };
  });
  const home = teams.find((team) => team.isHome === true) ?? teams[0]!;
  const away = teams.find((team) => team.isHome === false) ?? teams.find((team) => team !== home) ?? teams[1]!;
  const enrichment = await createMatchPulseEnrichmentService(config).enrichCommentaryEntries(
    {
      homeTeam: { id: String(home.teamId), name: home.name },
      awayTeam: { id: String(away.teamId), name: away.name },
      allowedSourceFrameIds: selected.flatMap(({ entry }) => entry.sourceFrameIds ?? []),
    },
    selected.map(({ entry }) => entry),
    [],
  );
  const traces = new Map(enrichment.traces?.map((trace) => [trace.entryId, trace]) ?? []);
  const results = selected.map((calibrationCase, index) => {
    const finalEntry = enrichment.entries[index];
    const trace = traces.get(calibrationCase.entry.id);
    return {
      case: calibrationCase.label,
      fromSeq: calibrationCase.fromSeq,
      importance: calibrationCase.entry.commentaryBeatKind,
      fallback: calibrationCase.entry.fallbackCommentary,
      draft: trace?.stages.find((stage) => stage.stage === 'draft')?.commentary,
      reflection: trace?.stages.find((stage) => stage.stage === 'reflection')?.commentary,
      final: finalEntry?.commentary,
      status: finalEntry?.enrichmentStatus,
      promptVersion: finalEntry?.enrichmentPromptVersion,
      stages: trace?.stages.map((stage) => ({
        stage: stage.stage,
        durationMs: stage.durationMs,
        usage: stage.usage,
      })) ?? [],
    };
  });
  const stages = [...traces.values()].flatMap((trace) => trace.stages);
  console.log(JSON.stringify({
    fixtureId,
    model: config.llmModel,
    cases: results.length,
    providerCalls: stages.length,
    completed: enrichment.completed,
    failed: enrichment.failed,
    totalDurationMs: stages.reduce((total, stage) => total + stage.durationMs, 0),
    usage: {
      promptTokens: sumUsage(stages, 'promptTokens'),
      completionTokens: sumUsage(stages, 'completionTokens'),
      totalTokens: sumUsage(stages, 'totalTokens'),
    },
    results,
  }, null, 2));
} finally {
  store.close();
}

function phasesByFrame(frames: readonly SemanticFrame[]): Map<string, MatchEnginePhase> {
  const result = new Map<string, MatchEnginePhase>();
  let phase: MatchEnginePhase = 'pre_match';
  for (const frame of [...frames].sort((left, right) =>
    left.stateRevision - right.stateRevision || left.seq - right.seq)) {
    const value = frame.facts.find((fact) => fact.kind === 'phase')?.value.phase
      ?? frame.simulationCues.find((cue) => cue.kind === 'phase_change')?.value.phase;
    if (isMatchEnginePhase(value)) phase = value;
    result.set(frame.id, phase);
  }
  return result;
}

function isMatchEnginePhase(value: unknown): value is MatchEnginePhase {
  return typeof value === 'string' && [
    'pre_match', 'first_half_ready', 'first_half', 'half_time',
    'second_half_ready', 'second_half', 'full_time_pending', 'finalised',
  ].includes(value);
}

function sumUsage(
  stages: readonly { usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }[],
  key: 'promptTokens' | 'completionTokens' | 'totalTokens',
): number | undefined {
  const values = stages.map((stage) => stage.usage?.[key]).filter((value): value is number => value !== undefined);
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
}
