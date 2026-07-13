import {
  applyTxlineMatchPulseLlmJson,
  buildTxlineMatchPulseEnrichmentPrompt,
  parseTxlineMatchPulseLlmJson,
  validateTxlineMatchPulseMoment,
  validateTxlineMatchPulseMoments,
  type MatchPulseCommentaryEntry,
  type MatchPulseMoment,
  type TxlineMatchPulseSourceContext,
  type TxlineMatchPulseValidationReport,
} from '@gamecrew/core';
import type { ApiConfig } from './config.js';

export interface MatchPulseEnrichmentService {
  enrichMoments(
    context: TxlineMatchPulseSourceContext,
    fallbackMoments: readonly MatchPulseMoment[],
  ): Promise<MatchPulseEnrichmentResult>;
  enrichCommentaryEntries(
    context: MatchPulseCommentaryGroundingContext,
    pendingEntries: readonly MatchPulseCommentaryEntry[],
    previousEntries: readonly MatchPulseCommentaryEntry[],
  ): Promise<MatchPulseCommentaryEnrichmentResult>;
}

/**
 * The engine worker only needs team labels and an allow-list of semantic frame
 * IDs to enrich commentary. `TxlineMatchPulseSourceContext` remains assignable
 * to this shape so legacy snapshot/replay callers do not need an adapter.
 */
export interface MatchPulseCommentaryGroundingContext {
  homeTeam: { id: string; name: string };
  awayTeam: { id: string; name: string };
  allowedSourceFrameIds?: readonly string[];
  sourceEvents?: ReadonlyArray<{ sourceRef: { id?: string } }>;
}

export interface MatchPulseEnrichmentResult {
  moments: readonly MatchPulseMoment[];
  reports: readonly TxlineMatchPulseValidationReport[];
  provider: 'disabled' | 'openai-compatible';
}

export interface MatchPulseCommentaryEnrichmentResult {
  entries: readonly MatchPulseCommentaryEntry[];
  provider: 'disabled' | 'openai-compatible';
  attempted: number;
  completed: number;
  failed: number;
  traces?: readonly MatchPulseCommentaryEnrichmentTrace[];
}

export interface MatchPulseCommentaryEnrichmentTrace {
  entryId: string;
  stages: readonly MatchPulseCommentaryEnrichmentStageTrace[];
}

export interface MatchPulseCommentaryEnrichmentStageTrace {
  stage: 'draft' | 'reflection';
  durationMs: number;
  commentary?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

interface MatchPulseCommentaryLlmJson {
  entryId?: string;
  batchId?: string;
  projectionGeneration?: number;
  commentary: string;
  voiceLine?: string;
  coveredFrameIds?: readonly string[];
}

type CommentaryImportance = 'routine' | 'developing' | 'major';
export const COMMENTARY_PROMPT_VERSION = 'engine-commentary-v1';
export const COMMENTARY_REFLECTION_PROMPT_VERSION = 'engine-commentary-v2-reflection';

class CommentaryValidationError extends Error {
  override name = 'CommentaryValidationError';
}

class CommentaryProviderError extends Error {
  override name = 'CommentaryProviderError';
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface ChatCompletionResult {
  content: string;
  durationMs: number;
  usage?: MatchPulseCommentaryEnrichmentStageTrace['usage'];
}

export function createMatchPulseEnrichmentService(config: ApiConfig): MatchPulseEnrichmentService {
  if (!config.llmEnabled || !config.llmBaseUrl) {
    return {
      async enrichMoments(context, fallbackMoments) {
        const validated = validateTxlineMatchPulseMoments(context, fallbackMoments);
        return {
          moments: validated.moments,
          reports: validated.reports,
          provider: 'disabled',
        };
      },
      async enrichCommentaryEntries() {
        return {
          entries: [],
          provider: 'disabled',
          attempted: 0,
          completed: 0,
          failed: 0,
          traces: [],
        };
      },
    };
  }

  return new OpenAiCompatibleMatchPulseEnrichmentService(config);
}

class OpenAiCompatibleMatchPulseEnrichmentService implements MatchPulseEnrichmentService {
  constructor(private readonly config: ApiConfig) {}

  async enrichMoments(
    context: TxlineMatchPulseSourceContext,
    fallbackMoments: readonly MatchPulseMoment[],
  ): Promise<MatchPulseEnrichmentResult> {
    const results = [];
    for (const fallbackMoment of fallbackMoments) {
      results.push(await this.enrichMoment(context, fallbackMoment));
    }

    return {
      moments: results.map((result) => result.moment),
      reports: results.map((result) => result.report),
      provider: 'openai-compatible',
    };
  }

  async enrichCommentaryEntries(
    context: MatchPulseCommentaryGroundingContext,
    pendingEntries: readonly MatchPulseCommentaryEntry[],
    previousEntries: readonly MatchPulseCommentaryEntry[],
  ): Promise<MatchPulseCommentaryEnrichmentResult> {
    const enrichedEntries: MatchPulseCommentaryEntry[] = [];
    const traces: MatchPulseCommentaryEnrichmentTrace[] = [];
    const previousContext = [...previousEntries];
    let failed = 0;

    for (const entry of pendingEntries) {
      const stages: MatchPulseCommentaryEnrichmentStageTrace[] = [];
      try {
        const prompt = buildCommentaryEnrichmentPrompt(context, entry, previousContext);
        const draftCompletion = await this.createChatCompletionResult(prompt);
        const content = draftCompletion.content;
        stages.push(toStageTrace('draft', draftCompletion));
        let draft: MatchPulseCommentaryEntry | undefined;
        let draftFailure: Error | undefined;
        try {
          draft = applyCommentaryLlmJson(
            context,
            entry,
            parseCommentaryLlmJson(content),
            previousContext,
          );
        } catch (error) {
          draftFailure = error instanceof Error ? error : new Error(String(error));
        }

        let enriched = draft;
        if (shouldReflectCommentary(entry)) {
          const reflectionPrompt = buildCommentaryReflectionPrompt(
            prompt,
            content,
            draftFailure?.message,
          );
          const reflectionCompletion = await this.createChatCompletionResult(reflectionPrompt);
          const reflectedContent = reflectionCompletion.content;
          stages.push(toStageTrace('reflection', reflectionCompletion));
          enriched = applyCommentaryLlmJson(
            context,
            entry,
            parseCommentaryLlmJson(reflectedContent),
            previousContext,
            COMMENTARY_REFLECTION_PROMPT_VERSION,
          );
        } else if (!enriched) {
          throw draftFailure ?? new CommentaryValidationError('Commentary draft could not be validated.');
        }
        enrichedEntries.push(enriched);
        previousContext.push(enriched);
      } catch (error) {
        if (error instanceof CommentaryProviderError) throw error;
        failed += 1;
        console.warn(JSON.stringify({
          event: 'match_pulse_commentary_enrichment_failed',
          entryId: entry.id,
          reason: error instanceof Error ? error.message : 'Unknown enrichment error',
        }));
        enrichedEntries.push({
          ...entry,
          enrichmentStatus: 'failed',
        });
      } finally {
        traces.push({ entryId: entry.id, stages });
      }
    }

    return {
      entries: enrichedEntries,
      provider: 'openai-compatible',
      attempted: pendingEntries.length,
      completed: enrichedEntries.filter((entry) => entry.enrichmentStatus === 'complete').length,
      failed,
      traces,
    };
  }

  private async enrichMoment(
    context: TxlineMatchPulseSourceContext,
    fallbackMoment: MatchPulseMoment,
  ) {
    try {
      const prompt = buildTxlineMatchPulseEnrichmentPrompt(context, fallbackMoment);
      const content = await this.createChatCompletion(prompt.messages);
      const llmJson = parseTxlineMatchPulseLlmJson(content);
      const candidate = applyTxlineMatchPulseLlmJson(fallbackMoment, llmJson);
      return validateTxlineMatchPulseMoment(context, candidate, { fallbackMoment });
    } catch {
      return validateTxlineMatchPulseMoment(context, fallbackMoment, { fallbackMoment });
    }
  }

  private async createChatCompletion(messages: readonly { role: 'system' | 'user'; content: string }[]): Promise<string> {
    return (await this.createChatCompletionResult(messages)).content;
  }

  private async createChatCompletionResult(
    messages: readonly { role: 'system' | 'user'; content: string }[],
  ): Promise<ChatCompletionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.llmTimeoutMs);
    const startedAt = performance.now();
    try {
      const response = await fetch(`${this.config.llmBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.llmApiKey ? { Authorization: `Bearer ${this.config.llmApiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.llmModel,
          messages,
          temperature: 0.4,
          ...getProviderRequestOptions(this.config.llmModel),
          max_tokens: 220,
          max_completion_tokens: 220,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`LLM request failed with ${response.status}`);
      }

      const payload = await response.json() as ChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('LLM response did not include message content.');
      }

      return {
        content,
        durationMs: Math.round(performance.now() - startedAt),
        ...(payload.usage ? {
          usage: {
            ...(typeof payload.usage.prompt_tokens === 'number'
              ? { promptTokens: payload.usage.prompt_tokens }
              : {}),
            ...(typeof payload.usage.completion_tokens === 'number'
              ? { completionTokens: payload.usage.completion_tokens }
              : {}),
            ...(typeof payload.usage.total_tokens === 'number'
              ? { totalTokens: payload.usage.total_tokens }
              : {}),
          },
        } : {}),
      };
    } catch (error) {
      throw new CommentaryProviderError(
        error instanceof Error ? error.message : 'Unknown LLM provider failure.',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toStageTrace(
  stage: MatchPulseCommentaryEnrichmentStageTrace['stage'],
  result: ChatCompletionResult,
): MatchPulseCommentaryEnrichmentStageTrace {
  let commentary: string | undefined;
  try {
    commentary = parseCommentaryLlmJson(result.content).commentary.trim();
  } catch {
    // Invalid structured output is still useful as a failed stage measurement.
  }
  return {
    stage,
    durationMs: result.durationMs,
    ...(commentary ? { commentary } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

export function buildCommentaryEnrichmentPrompt(
  context: MatchPulseCommentaryGroundingContext,
  entry: MatchPulseCommentaryEntry,
  previousEntries: readonly MatchPulseCommentaryEntry[],
): readonly { role: 'system' | 'user'; content: string }[] {
  const orderedSources = [...entry.sourceEvents].sort(compareSourceEventsBySeq);
  const mustCoverFacts = entry.groundedFacts?.length
    ? entry.groundedFacts
    : orderedSources.map((source, index) => ({
        id: getSourceFrameId(source, index),
        frameId: entry.sourceFrameIds?.[index] ?? getSourceFrameId(source, index),
        seq: source.seq,
        action: source.action ?? source.label ?? 'match update',
        team: source.teamName,
        confirmed: source.confirmed,
        value: {},
        sourceSeqs: source.seq === undefined ? [] : [source.seq],
      }));
  const importance = getCommentaryImportance(entry);
  const recentSpoken = previousEntries
    .filter((previous) => previous.commentary.trim().length > 0)
    .slice(-4);
  const immediatelyPrevious = recentSpoken.at(-1);
  const modelInput = {
    match: {
      home: context.homeTeam.name,
      away: context.awayTeam.name,
    },
    contract: {
      entryId: entry.id,
      batchId: entry.batchId,
      projectionGeneration: entry.projectionGeneration,
      promptVersion: COMMENTARY_PROMPT_VERSION,
      fromSeq: entry.fromSeq,
      toSeq: entry.toSeq,
      requiredCoveredFrameIds: getRequiredFrameIds(entry),
      factIds: entry.factIds,
      cueIds: entry.cueIds,
    },
    currentBeat: {
      kind: entry.kind,
      importance,
      intensity: entry.intensity,
      phase: entry.period,
      clock: entry.clock.label,
      score: entry.scoreAtMoment ? `${entry.scoreAtMoment.home}-${entry.scoreAtMoment.away}` : undefined,
      team: entry.team?.name,
      opponent: entry.opponent?.name,
      development: classifyBeatDevelopment(entry, immediatelyPrevious),
      mustCoverFacts,
    },
    broadcastMemory: {
      lastMajorIncident: [...previousEntries]
        .reverse()
        .find((previous) => getCommentaryImportance(previous) === 'major')
        ?.kind,
      lastMentionedScore: [...recentSpoken].reverse().find((previous) => previous.scoreAtMoment)?.scoreAtMoment,
      recentOpenings: recentSpoken.map((previous) => getOpening(previous.commentary)),
      recentActionCounts: countRecentActions(recentSpoken),
      recentLines: recentSpoken.map((previous) => ({
        entryId: previous.id,
        clock: previous.clock.label,
        team: previous.team?.name,
        actions: [...previous.sourceEvents]
          .sort(compareSourceEventsBySeq)
          .map((source) => source.action ?? source.label)
          .filter((action): action is string => Boolean(action)),
        commentary: previous.commentary,
      })),
    },
  };

  return [
    {
      role: 'system',
      content: [
        'You are GameCrew Match Pulse, a football commentator following the match moment by moment.',
        'Sound like a human commentator speaking to supporters who are following live, not like an event log, notification template, or data analyst.',
        '',
        'CONTINUITY:',
        'Write only the current update, but treat recent commentary as words you have already spoken during the same live broadcast.',
        'Make the new line answer: what changed since the previous line?',
        'If recent actions show a repeated event, acknowledge it naturally with another, again, still, or the pressure continues.',
        'Never say another or again unless the supplied records establish the earlier action.',
        'The interface already shows the minute. Omit it from routine commentary unless timing itself makes the moment significant.',
        'Do not keep repeating the score, competition, matchup, or both full team names when listeners already have that context.',
        '',
        'VOICE:',
        'Use natural spoken football English with varied sentence openings and rhythm.',
        'Match the currentBeat importance: routine needs one concise connected sentence; developing may use one or two connected sentences; major may breathe for two or three short sentences.',
        'Be lively when the facts deserve it, but do not manufacture drama.',
        'Avoid event-log phrasing, stat-list phrasing, and stock lines such as looking to, setting the tempo, building pressure, knocking on the door, early doors, warning signs, or asking questions.',
        'For kickoff, prefer one direct line such as "And we are underway" or "[Team] get us underway". Do not say kickoff and the game begins in the same line.',
        '',
        'STYLE EXAMPLE — copy the conversational movement, never its facts or bracketed placeholders:',
        '"[Team] get us underway."',
        '"[Team] take an early throw-in before winning a free kick moments later."',
        '"Another one for [Team] moments later. [Opponent] have barely managed to get out."',
        '"That spell now brings a shot from [Team]."',
        '"That early pressure continues: a corner for [Team], followed by two efforts."',
        '',
        'GROUNDING:',
        'The currentBeat and its mustCoverFacts are the only authority for what happened now. Broadcast memory is continuity context, not evidence for a new current fact.',
        'Cover every mustCoverFact in its supplied seq order. coveredFrameIds is an auditable claim of which supplied facts the line covers, not permission to add facts.',
        'Sparse event data is not full play-by-play. Do not invent causal links, player names, formations, injuries, exact locations, possession, chance quality, or event outcomes.',
        'Do not invent crowd, stadium, celebration, referee-action, score-state, or atmosphere details. Do not describe what can be heard or say that the place lifts or erupts. Mention a lead or score only when currentBeat.score supplies it.',
        'Do not mention the box, goalkeeper, save, miss, block, clearance, delivery, cross, header, goal, card, penalty, VAR, or score change unless that fact is explicitly supplied for the current entry.',
        'In particular, when current events contain only shots, corners, free kicks, or throw-ins, do not use goal, goalward, goalmouth, net, scorer, opener, breakthrough, or scoring language.',
        'Never expose confidence, verification, source, validation, action-label, or schema terminology to the supporter.',
        '',
        'OUTPUT:',
        'Return only valid JSON.',
        'Use exactly this shape: {"entryId":"echo contract.entryId","batchId":"echo contract.batchId","projectionGeneration":0,"commentary":"...","voiceLine":"optional shorter spoken alternative","coveredFrameIds":["every requiredCoveredFrameId"]}. Echo contract.projectionGeneration as the number when supplied; otherwise omit it.',
        'Omit voiceLine when it would merely repeat commentary.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify(modelInput),
    },
  ];
}

export function buildCommentaryReflectionPrompt(
  original: readonly { role: 'system' | 'user'; content: string }[],
  draftContent: string,
  validationFailure?: string,
): readonly { role: 'system' | 'user'; content: string }[] {
  return [
    ...original,
    {
      role: 'user',
      content: JSON.stringify({
        reflection: true,
        draftOutput: draftContent,
        ...(validationFailure ? { validationFailure } : {}),
        checklist: [
          'Cover every originally supplied fact and lifecycle meaning.',
          'Use only grounded teams, players, scores, actions, and continuity.',
          'Use explicit grounded event language: say goal or scores for a goal, red card or yellow card for a card, and state the supplied restart context.',
          'Copy or naturally shorten only the supplied playerName; never replace it with another player.',
          'Describe only the current beat. Do not announce a future restart, phase, or action.',
          'Do not add physical details about how an event happened unless those details are supplied.',
          'Do not add crowd, stadium, celebration, referee-action, or score-state details unless they are supplied.',
          'Sound like natural live football commentary rather than an event log.',
          'Connect naturally with the supplied broadcast memory without repeating recent phrasing.',
          'Match the beat importance and remain concise.',
        ],
        instruction: 'Critique the draft silently, then return only one improved final JSON object. Echo the original contract metadata and requiredCoveredFrameIds exactly.',
      }),
    },
  ];
}

function shouldReflectCommentary(entry: MatchPulseCommentaryEntry): boolean {
  const importance = getCommentaryImportance(entry);
  return importance === 'major' || importance === 'developing';
}

function compareSourceEventsBySeq(
  left: MatchPulseCommentaryEntry['sourceEvents'][number],
  right: MatchPulseCommentaryEntry['sourceEvents'][number],
): number {
  return (left.seq ?? Number.MAX_SAFE_INTEGER) - (right.seq ?? Number.MAX_SAFE_INTEGER);
}

function getSourceFrameId(
  source: MatchPulseCommentaryEntry['sourceEvents'][number],
  index: number,
): string {
  return source.id
    ?? (source.seq !== undefined ? `${source.kind}:${source.seq}` : `${source.kind}:${index}`);
}

function getCommentaryImportance(entry: MatchPulseCommentaryEntry): CommentaryImportance {
  if (entry.commentaryBeatKind === 'major') return 'major';
  if (entry.commentaryBeatKind === 'pressure') return 'developing';
  if (entry.commentaryBeatKind === 'routine') return 'routine';
  if (
    entry.intensity === 'major'
    || ['goal', 'penalty', 'var', 'card', 'phase_change'].includes(entry.kind)
  ) {
    return 'major';
  }
  if (entry.intensity === 'danger' || entry.intensity === 'building' || entry.sourceEvents.length > 1 || entry.kind === 'momentum') {
    return 'developing';
  }
  return 'routine';
}

function getRequiredFrameIds(entry: MatchPulseCommentaryEntry): readonly string[] {
  return entry.sourceFrameIds?.length
    ? entry.sourceFrameIds
    : entry.sourceEvents.map(getSourceFrameId);
}

function classifyBeatDevelopment(
  entry: MatchPulseCommentaryEntry,
  previous?: MatchPulseCommentaryEntry,
): 'new' | 'continuing_same_team' | 'repeated_action' {
  if (!previous) return 'new';
  const currentActions = new Set(entry.sourceEvents.map((source) => source.action).filter(Boolean));
  const previousActions = new Set(previous.sourceEvents.map((source) => source.action).filter(Boolean));
  if ([...currentActions].some((action) => previousActions.has(action))) return 'repeated_action';
  if (entry.team?.id && entry.team.id === previous.team?.id) return 'continuing_same_team';
  return 'new';
}

function countRecentActions(entries: readonly MatchPulseCommentaryEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    for (const source of entry.sourceEvents) {
      const action = source.action ?? source.label;
      if (action) counts[action] = (counts[action] ?? 0) + 1;
    }
  }
  return counts;
}

function getOpening(commentary: string): string {
  return normalizeCommentary(commentary).split(' ').slice(0, 4).join(' ');
}

function getProviderRequestOptions(model: string): Record<string, unknown> {
  if (/^MiniMax-M3$/i.test(model)) {
    return {
      thinking: {
        type: 'disabled',
      },
    };
  }

  return {};
}

export function parseCommentaryLlmJson(content: string): MatchPulseCommentaryLlmJson {
  const parsed = JSON.parse(extractJsonObject(content));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Commentary LLM response is not a JSON object.');
  }

  const candidate = parsed as Partial<MatchPulseCommentaryLlmJson>;
  if (typeof candidate.commentary !== 'string') {
    throw new Error('Commentary LLM response must include commentary.');
  }

  return {
    entryId: typeof candidate.entryId === 'string' ? candidate.entryId : undefined,
    batchId: typeof candidate.batchId === 'string' ? candidate.batchId : undefined,
    projectionGeneration: typeof candidate.projectionGeneration === 'number'
      ? candidate.projectionGeneration
      : undefined,
    commentary: candidate.commentary,
    voiceLine: typeof candidate.voiceLine === 'string' ? candidate.voiceLine : undefined,
    coveredFrameIds: Array.isArray(candidate.coveredFrameIds)
      ? candidate.coveredFrameIds.filter((value): value is string => typeof value === 'string')
      : undefined,
  };
}

function applyCommentaryLlmJson(
  context: MatchPulseCommentaryGroundingContext,
  entry: MatchPulseCommentaryEntry,
  llmJson: MatchPulseCommentaryLlmJson,
  previousEntries: readonly MatchPulseCommentaryEntry[],
  promptVersion = COMMENTARY_PROMPT_VERSION,
): MatchPulseCommentaryEntry {
  validateCommentaryLlmJson(context, entry, llmJson, previousEntries);

  return {
    ...entry,
    commentary: llmJson.commentary.trim(),
    voiceLine: llmJson.voiceLine?.trim(),
    generation: 'llm',
    enrichmentStatus: 'complete',
    fallbackCommentary: entry.fallbackCommentary,
    coveredFrameIds: llmJson.coveredFrameIds,
    enrichmentPromptVersion: promptVersion,
  };
}

export function validateCommentaryLlmJson(
  context: MatchPulseCommentaryGroundingContext,
  entry: MatchPulseCommentaryEntry,
  llmJson: MatchPulseCommentaryLlmJson,
  previousEntries: readonly MatchPulseCommentaryEntry[] = [],
): void {
  const commentary = llmJson.commentary.trim();
  const voiceLine = llmJson.voiceLine?.trim();
  const combined = `${commentary} ${voiceLine ?? ''}`;
  if (!commentary) {
    throw new CommentaryValidationError('Commentary must be non-empty.');
  }

  if (llmJson.entryId !== entry.id || llmJson.batchId !== entry.batchId) {
    throw new CommentaryValidationError('Commentary contract metadata does not match the current entry generation.');
  }
  if (
    entry.projectionGeneration !== undefined
    && llmJson.projectionGeneration !== entry.projectionGeneration
  ) {
    throw new CommentaryValidationError('Commentary projection generation does not match the current engine generation.');
  }

  const requiredFrameIds = getRequiredFrameIds(entry);
  if (
    context.allowedSourceFrameIds
    && requiredFrameIds.some((frameId) => !context.allowedSourceFrameIds!.includes(frameId))
  ) {
    throw new CommentaryValidationError('Commentary beat references a frame outside the worker grounding allow-list.');
  }
  const coveredFrameIds = new Set(llmJson.coveredFrameIds ?? []);
  const missingFrameIds = requiredFrameIds.filter((frameId) => !coveredFrameIds.has(frameId));
  if (missingFrameIds.length > 0) {
    throw new CommentaryValidationError(`Commentary did not cover required frames: ${missingFrameIds.join(', ')}.`);
  }
  if ([...coveredFrameIds].some((frameId) => !requiredFrameIds.includes(frameId))) {
    throw new CommentaryValidationError('Commentary claimed a frame that is not part of the current beat.');
  }

  const words = commentary.split(/\s+/).filter(Boolean).length;
  const maxWords = getCommentaryImportance(entry) === 'major' ? 75 : getCommentaryImportance(entry) === 'developing' ? 50 : 32;
  if (words > maxWords) {
    throw new CommentaryValidationError(`Commentary exceeds the ${maxWords}-word limit for this beat.`);
  }
  if (voiceLine && voiceLine.split(/\s+/).filter(Boolean).length > 22) {
    throw new CommentaryValidationError('Voice line exceeds the 22-word limit.');
  }

  if (/\b(?:verified|verdict|confidence|source[_ -]?backed)\b/i.test(combined)) {
    throw new CommentaryValidationError('Commentary cannot expose validation or confidence metadata.');
  }

  const sourceActions = new Set([
    ...entry.sourceEvents.map((source) => normalizeAction(source.action)),
    ...(entry.groundedFacts ?? []).flatMap((fact) => [
      normalizeAction(fact.action),
      normalizeCueKind(fact.kind),
    ]),
  ].filter(Boolean));
  assertNoUnsupportedClaim(
    combined,
    'goal',
    entry.kind === 'goal' || sourceActions.has('goal') || getRestartContext(entry) === 'after_goal',
  );
  assertNoUnsupportedClaim(combined, 'penalty', entry.kind === 'penalty' || sourceActions.has('penalty'));
  assertNoUnsupportedClaim(combined, 'var', entry.kind === 'var' || sourceActions.has('var'));
  assertNoUnsupportedClaim(
    combined,
    'red card',
    sourceActions.has('red_card'),
  );

  for (const [phrase, allowed] of [
    ['save', sourceActions.has('save')],
    ['miss', sourceActions.has('miss')],
    ['block', sourceActions.has('block')],
    ['injury', sourceActions.has('injury')],
    ['offside', sourceActions.has('offside')],
    ['goalkeeper', sourceActions.has('save')],
    ['clearance', sourceActions.has('clearance')],
    ['cross', sourceActions.has('cross')],
    ['header', sourceActions.has('header')],
    ['box', false],
    ['left flank', false],
    ['right flank', false],
    ['left wing', false],
    ['right wing', false],
    ['penalty area', false],
    ['six-yard box', false],
    ['own half', false],
    ['opposition half', false],
    ['own third', false],
    ['opposition third', false],
    ['final third', false],
    ['attacking third', false],
    ['defensive third', false],
    ['byline', false],
    ['pushing high', false],
    ['pressing high', false],
    ['high up the pitch', false],
    ['near post', false],
    ['far post', false],
    ['centre circle', false],
  ] as const) {
    assertNoUnsupportedClaim(combined, phrase, allowed);
  }
  for (const teamName of [context.homeTeam.name, context.awayTeam.name]) {
    if (new RegExp(`\\b${escapeRegExp(teamName)} (?:half|third)\\b`, 'i').test(combined)) {
      throw new CommentaryValidationError('Commentary made an unsupported team-zone location claim.');
    }
  }
  assertNoUnsupportedClaim(
    combined,
    'yellow card',
    sourceActions.has('yellow_card'),
  );

  if (/\b(odds?|bet|bets|betting|wager|price)\b/i.test(combined)) {
    throw new CommentaryValidationError('Commentary cannot include betting language.');
  }

  assertScoreClaims(commentary, entry);
  if (voiceLine) assertScoreClaims(voiceLine, entry);

  if (!entry.scoreAtMoment && /\b(?:leads?|leading|trails?|trailing|level|ahead|behind)\b/i.test(combined)) {
    throw new CommentaryValidationError('Commentary cannot state a score relationship without grounded score context.');
  }
  if (/\b(?:crowd|fans?|stadium|supporters?|hear the place|place (?:lifts?|erupts?))\b/i.test(combined)) {
    throw new CommentaryValidationError('Commentary cannot invent crowd or stadium atmosphere.');
  }
  if (/\b(?:puts?|raises?) (?:the )?whistle\b|\bwhistle to (?:his|her|their) lips\b|\b(?:the )?referee blows?\b/i.test(combined)) {
    throw new CommentaryValidationError('Commentary cannot invent a physical referee action.');
  }
  assertNoFutureSpeculation(combined, entry);

  assertClosedWorldMaterialActions(combined, sourceActions, entry);
  assertMaterialActionCoverage(commentary, sourceActions, entry);
  assertGroundedTeamAttribution(combined, context, entry);
  assertGroundedMultiplicity(commentary, entry);
  assertGroundedMajorFacts(combined, entry);
  assertGroundedFootballDetails(combined, entry);
  assertNoInventedPlayerName(combined, context, entry);
  assertGroundedContinuity(combined, entry, previousEntries);

  const normalized = normalizeCommentary(commentary);
  const recent = previousEntries.filter((previous) => previous.commentary.trim()).slice(-4);
  if (recent.some((previous) => normalizeCommentary(previous.commentary) === normalized)) {
    throw new CommentaryValidationError('Commentary repeats a recent line verbatim.');
  }
  const opening = getOpening(commentary);
  if (opening.split(' ').length >= 4 && recent.slice(-2).some((previous) => getOpening(previous.commentary) === opening)) {
    throw new CommentaryValidationError('Commentary repeats a recent sentence opening.');
  }

  if (context.sourceEvents) {
    const sourceIds = new Set(context.sourceEvents.map((source) => source.sourceRef.id).filter(Boolean));
    for (const sourceEvent of entry.sourceEvents) {
      if (sourceEvent.id && !sourceIds.has(sourceEvent.id)) {
        throw new CommentaryValidationError(`Commentary references unknown source event ${sourceEvent.id}.`);
      }
    }
  }
}

function assertScoreClaims(text: string, entry: MatchPulseCommentaryEntry): void {
  const claims = [...text.matchAll(/\b(\d{1,2})\s*[-:]\s*(\d{1,2})\b/g)];
  if (claims.length > 1) throw new CommentaryValidationError('Commentary cannot state multiple score claims.');
  const claim = claims[0];
  if (!claim) return;
  if (!entry.scoreAtMoment) {
    throw new CommentaryValidationError('Commentary cannot state a score without a source score.');
  }
  if (Number(claim[1]) !== entry.scoreAtMoment.home || Number(claim[2]) !== entry.scoreAtMoment.away) {
    throw new CommentaryValidationError('Commentary score claim does not match source score.');
  }
}

function assertNoFutureSpeculation(text: string, entry: MatchPulseCommentaryEntry): void {
  const groundedPlayerTokens = (entry.groundedFacts ?? [])
    .map((fact) => fact.playerName)
    .filter((value): value is string => Boolean(value))
    .map((name) => new Set(normalizeForComparison(name).split(' ').filter(Boolean)));
  for (const match of text.matchAll(/\bwill\b/gi)) {
    const nextToken = text.slice((match.index ?? 0) + match[0].length).match(/^\s+([\p{L}'’.-]+)/u)?.[1];
    const isGroundedPlayerName = match[0] === 'Will'
      && nextToken !== undefined
      && groundedPlayerTokens.some((tokens) => tokens.has('will') && tokens.has(normalizeForComparison(nextToken)));
    if (!isGroundedPlayerName) {
      throw new CommentaryValidationError('Commentary cannot speculate about a future action.');
    }
  }
}

function assertNoUnsupportedClaim(text: string, phrase: string, allowed: boolean): void {
  const inflected = phrase === 'goal' ? 'goal(?:s|ed|ing)?(?![ -]?kick)'
    : phrase === 'save' ? 'sav(?:e|es|ed|ing)'
    : phrase === 'miss' ? 'miss(?:es|ed|ing)?'
      : phrase === 'block' ? 'block(?:s|ed|ing)?'
        : phrase === 'injury' ? 'injur(?:y|ies|ed)'
          : phrase === 'penalty' ? 'penalt(?:y|ies)'
            : `${phrase}(?:s|es|ed|ing)?`;
  if (!allowed && new RegExp(`\\b${inflected}\\b`, 'i').test(text)) {
    throw new CommentaryValidationError(`Commentary made unsupported ${phrase} claim.`);
  }
}

function normalizeAction(action: MatchPulseCommentaryEntry['sourceEvents'][number]['action']): string {
  return String(action ?? '').toLowerCase().replace(/[ -]+/g, '_');
}

function normalizeCueKind(kind: string): string {
  if (kind === 'goal_confirmed' || kind === 'goal_pending') return 'goal';
  if (kind === 'shot_attempt' || kind === 'shot_outcome') return 'shot';
  return normalizeAction(kind);
}

const MATERIAL_ACTIONS: readonly {
  actions: readonly string[];
  pattern: RegExp;
  label: string;
}[] = [
  { actions: ['goal'], pattern: /\b(?:goal|scores?|scored|net(?:s|ted)?|equalis(?:e|es|ed)|breakthrough)\b/i, label: 'goal' },
  { actions: ['corner'], pattern: /\bcorners?\b/i, label: 'corner' },
  { actions: ['shot'], pattern: /\b(?:shots?|efforts?|attempts?|shoots?|fired?|strikes?)\b/i, label: 'shot' },
  { actions: ['free_kick'], pattern: /\bfree[ -]?kicks?\b/i, label: 'free kick' },
  { actions: ['throw_in'], pattern: /\bthrow[ -]?ins?\b/i, label: 'throw-in' },
  { actions: ['goal_kick'], pattern: /\bgoal[ -]?kicks?\b/i, label: 'goal kick' },
  { actions: ['penalty'], pattern: /\bpenalt(?:y|ies)\b/i, label: 'penalty' },
  { actions: ['red_card', 'yellow_card'], pattern: /\b(?:(?:(?:red|yellow)\s+)?cards?|straight red|sent off)\b/i, label: 'card' },
  { actions: ['substitution'], pattern: /\b(?:substitutions?|subs?|changes?|replaced|replaces|comes? (?:on|off))\b/i, label: 'substitution' },
  { actions: ['save'], pattern: /\b(?:sav(?:e|es|ed|ing)|goalkeeper)\b/i, label: 'save' },
  { actions: ['miss'], pattern: /\bmiss(?:es|ed|ing)?\b/i, label: 'miss' },
  { actions: ['block'], pattern: /\bblock(?:s|ed|ing)?\b/i, label: 'block' },
  { actions: ['offside'], pattern: /\boffsides?\b/i, label: 'offside' },
  { actions: ['clearance'], pattern: /\bclear(?:ance|ances|s|ed|ing)\b/i, label: 'clearance' },
  { actions: ['cross'], pattern: /\bcross(?:es|ed|ing)?\b/i, label: 'cross' },
  { actions: ['header'], pattern: /\bhead(?:er|ers|ed|ing)\b/i, label: 'header' },
  { actions: ['injury'], pattern: /\b(?:injur(?:y|ies|ed)|hurt)\b/i, label: 'injury' },
  { actions: ['var'], pattern: /\b(?:var|video assistant|video review|being checked)\b/i, label: 'VAR' },
  { actions: ['additional_time'], pattern: /\b(?:additional|added|stoppage) time\b/i, label: 'additional time' },
  { actions: ['restart'], pattern: /\b(?:kick[ -]?off|underway|restarts?|restarted)\b/i, label: 'restart' },
];

function assertClosedWorldMaterialActions(
  text: string,
  sourceActions: ReadonlySet<string>,
  entry: MatchPulseCommentaryEntry,
): void {
  for (const claim of MATERIAL_ACTIONS) {
    const claimText = claim.label === 'shot' && sourceActions.has('goal')
      ? text.replace(/\bstrikes? first\b/gi, '')
      : text;
    const contextualGoal = claim.label === 'goal' && getRestartContext(entry) === 'after_goal';
    const contextualAddedTime = claim.label === 'additional time' && isClockGroundedStoppageTime(entry);
    if (
      claim.pattern.test(claimText)
      && !contextualGoal
      && !contextualAddedTime
      && !claim.actions.some((action) => sourceActions.has(action))
    ) {
      throw new CommentaryValidationError(`Commentary made unsupported ${claim.label} claim.`);
    }
  }
}

function assertMaterialActionCoverage(
  text: string,
  sourceActions: ReadonlySet<string>,
  entry: MatchPulseCommentaryEntry,
): void {
  const requirements: readonly [readonly string[], RegExp, string][] = [
    [['goal'], /\b(?:goal|scores?|scored|finds? the net|breakthrough)\b/i, 'goal'],
    [['corner'], /\bcorners?\b/i, 'corner'],
    [['shot'], /\b(?:shots?|efforts?|attempts?)\b/i, 'shot'],
    [['free_kick'], /\bfree[ -]?kick\b/i, 'free kick'],
    [['throw_in'], /\bthrow[ -]?in\b/i, 'throw-in'],
    [['penalty'], /\bpenalt(?:y|ies)\b/i, 'penalty'],
    [['red_card', 'yellow_card'], /\b(?:(?:red|yellow)?\s*card|straight red|sent off)\b/i, 'card'],
    [['substitution'], /\b(?:substitution|change|replaced|comes? (?:on|off))\b/i, 'substitution'],
    [['injury'], /\b(?:injur(?:y|ies|ed)|hurt)\b/i, 'injury'],
    [['var'], /\b(?:var|video assistant|video review|being checked)\b/i, 'VAR'],
    [['additional_time'], /\b(?:additional|added|stoppage) time\b/i, 'additional time'],
    [['restart'], /\b(?:kick[ -]?off|underway|restarts?|restarted)\b/i, 'restart'],
  ];
  for (const [actions, pattern, label] of requirements) {
    if (actions.some((action) => sourceActions.has(action)) && !pattern.test(text)) {
      throw new CommentaryValidationError(`Commentary omitted the required ${label} fact.`);
    }
  }

  const phases = (entry.groundedFacts ?? [])
    .filter((fact) => normalizeCueKind(fact.kind) === 'phase_change' || normalizeAction(fact.action) === 'phase_change')
    .map((fact) => normalizeAction(fact.value?.phase as string | undefined));
  if (phases.includes('half_time') && !/\b(?:half[ -]?time|first half (?:ends?|is over)|interval)\b/i.test(text)) {
    throw new CommentaryValidationError('Commentary omitted the required halftime fact.');
  }
  if (phases.includes('finalised') && !/\b(?:full[ -]?time|match is over|final whistle|game is over)\b/i.test(text)) {
    throw new CommentaryValidationError('Commentary omitted the required full-time fact.');
  }
  if (sourceActions.has('restart')) {
    const restartContext = getRestartContext(entry);
    if (restartContext === 'second_half' && !/\bsecond half\b/i.test(text)) {
      throw new CommentaryValidationError('Commentary omitted the required second-half restart context.');
    }
    if (restartContext === 'after_goal' && !/\b(?:after|following) (?:(?:the|that) )?goal\b/i.test(text)) {
      throw new CommentaryValidationError('Commentary omitted the required post-goal restart context.');
    }
  }
}

function isClockGroundedStoppageTime(entry: MatchPulseCommentaryEntry): boolean {
  const minute = entry.clock.minute;
  return typeof minute === 'number' && (
    (entry.period === 'first_half' && minute > 45)
    || (entry.period === 'second_half' && minute > 90)
  );
}

function getRestartContext(entry: MatchPulseCommentaryEntry): string | undefined {
  const restart = (entry.groundedFacts ?? []).find((fact) =>
    normalizeAction(fact.action) === 'restart' || normalizeCueKind(fact.kind) === 'restart');
  return typeof restart?.value.context === 'string' ? restart.value.context : undefined;
}

function assertGroundedTeamAttribution(
  text: string,
  context: MatchPulseCommentaryGroundingContext,
  entry: MatchPulseCommentaryEntry,
): void {
  const facts = entry.groundedFacts ?? [];
  const normalized = normalizeForComparison(text);
  for (const claim of MATERIAL_ACTIONS) {
    if (!claim.pattern.test(text)) continue;
    const actionFacts = facts.filter((fact) => claim.actions.includes(normalizeAction(fact.action))
      || claim.actions.includes(normalizeCueKind(fact.kind)));
    const groundedTeamIds = new Set(actionFacts.map((fact) => fact.teamId).filter((id) => id !== undefined).map(String));
    if (groundedTeamIds.size === 0) continue;
    for (const team of [context.homeTeam, context.awayTeam]) {
      if (groundedTeamIds.has(String(team.id))) continue;
      const teamName = escapeRegExp(normalizeForComparison(team.name));
      const actionWords = claim.label === 'goal'
        ? '(?:goal|scores?|scored|breakthrough)'
        : claim.label === 'substitution'
          ? '(?:substitution|change|replaced|comes? on|comes? off)'
          : escapeRegExp(claim.label).replace(' ', '[ -]?');
      const attributed = new RegExp(`\\b${teamName}\\b(?:\\s+\\w+){0,5}\\s+${actionWords}\\b|\\b${actionWords}\\b(?:\\s+\\w+){0,4}\\s+(?:for|by)\\s+${teamName}\\b`);
      if (attributed.test(normalized)) {
        throw new CommentaryValidationError(`Commentary attributed the ${claim.label} to the wrong team.`);
      }
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function groundedActionCounts(entry: MatchPulseCommentaryEntry): Map<string, number> {
  const facts = new Map((entry.groundedFacts ?? []).map((fact) => [fact.id, fact]));
  const counts = new Map<string, number>();
  for (const fact of facts.values()) {
    const action = normalizeAction(fact.action) || normalizeCueKind(fact.kind);
    if (!action) continue;
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  return counts;
}

function assertGroundedMultiplicity(text: string, entry: MatchPulseCommentaryEntry): void {
  const counts = groundedActionCounts(entry);
  for (const [action, nouns] of [
    ['corner', '(?:corners?)'],
    ['shot', '(?:shots?|efforts?|attempts?)'],
  ] as const) {
    const count = counts.get(action) ?? 0;
    if (count < 2) continue;
    const number = count <= 10
      ? `(?:${count}|${['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][count]})`
      : String(count);
    if (!new RegExp(`\\b${number}\\s+${nouns}\\b`, 'i').test(text)) {
      throw new CommentaryValidationError(`Commentary did not preserve the grounded count of ${count} ${action}s.`);
    }
  }
}

function assertGroundedMajorFacts(text: string, entry: MatchPulseCommentaryEntry): void {
  const facts = entry.groundedFacts ?? [];
  const goal = facts.find((fact) => normalizeAction(fact.action) === 'goal' || normalizeCueKind(fact.kind) === 'goal');
  if (goal?.playerName && !hasGroundedPlayerReference(text, goal.playerName)) {
    throw new CommentaryValidationError('Commentary omitted or changed the grounded scorer name.');
  }
  if (goal && entry.scoreAtMoment) {
    const score = new RegExp(`\\b${entry.scoreAtMoment.home}\\s*[-:]\\s*${entry.scoreAtMoment.away}\\b`);
    if (!score.test(text)) {
      throw new CommentaryValidationError('Goal commentary omitted the grounded score.');
    }
  }
  if (facts.some((fact) => normalizeAction(fact.action) === 'red_card') && !/\b(?:red\s+card|straight red|sent off)\b/i.test(text)) {
    throw new CommentaryValidationError('Commentary omitted the grounded red-card type.');
  }
  if (facts.some((fact) => normalizeAction(fact.action) === 'yellow_card') && !/\byellow\s+card\b/i.test(text)) {
    throw new CommentaryValidationError('Commentary omitted the grounded yellow-card type.');
  }
}

function hasGroundedPlayerReference(text: string, playerName: string): boolean {
  const supplied = [...new Set(normalizeForComparison(playerName).split(' ').filter((token) => token.length > 1))];
  const spoken = new Set(normalizeForComparison(text).split(' '));
  const requiredMatches = Math.min(2, supplied.length);
  return supplied.filter((token) => spoken.has(token)).length >= requiredMatches;
}

function assertNoInventedPlayerName(
  text: string,
  context: MatchPulseCommentaryGroundingContext,
  entry: MatchPulseCommentaryEntry,
): void {
  const allowed = new Set<string>();
  for (const value of [
    context.homeTeam.name,
    context.awayTeam.name,
    entry.team?.name,
    entry.opponent?.name,
    ...(entry.groundedFacts ?? []).map((fact) => fact.playerName),
  ]) {
    for (const token of String(value ?? '').match(/\p{L}+/gu) ?? []) allowed.add(normalizeForComparison(token));
  }
  const common = new Set([
    'a', 'additional', 'after', 'an', 'and', 'another', 'away', 'corner', 'deep', 'first', 'free',
    'both', 'full', 'goal', 'half', 'halftime', 'home', 'it', 'moments', 'now', 'one',
    'play', 'pressure', 'second', 'still', 'straight', 'substitution', 'that', 'the', 'these',
    'they', 'this', 'those', 'there', 'var', 'with',
  ]);
  const capitalized = [...text.matchAll(/\b\p{Lu}[\p{L}'’.-]*\b/gu)];
  const invented = capitalized.find((match) => {
    const preceding = text.slice(0, match.index ?? 0);
    const sentenceInitial = preceding.trim().length === 0 || /[.!?]\s*$/.test(preceding);
    if (sentenceInitial) return false;
    const withoutPossessive = match[0].replace(/['’]s$/iu, '');
    const words = normalizeForComparison(withoutPossessive).split(' ').filter(Boolean);
    return words.some((word) => !allowed.has(word) && !common.has(word));
  })?.[0];
  if (invented) {
    throw new CommentaryValidationError(`Commentary introduced an ungrounded proper name: ${invented}.`);
  }

  const groundedPlayerNames = (entry.groundedFacts ?? [])
    .map((fact) => fact.playerName)
    .filter((value): value is string => Boolean(value));
  const groundedPlayers = groundedPlayerNames.map(normalizeForComparison);
  const attribution = normalizeForComparison(text).match(
    /\b(?:scored by|goal from|effort from|shot from|corner by|card for)\s+([a-z][a-z0-9' -]{1,50})/,
  )?.[1];
  if (attribution && !groundedPlayers.some((player) => attribution.startsWith(player))) {
    throw new CommentaryValidationError('Commentary attributed an action to an ungrounded player.');
  }
  const subject = text
    .split(/(?:^|[.!?]\s+)/)
    .map(normalizeForComparison)
    .map((sentence) => sentence.match(
      /^([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3})\s+(?:takes|scores|shoots|heads|crosses|wins|fires|strikes|converts|assists)\b/,
    )?.[1])
    .find((value): value is string => Boolean(value));
  const groundedTeams = [context.homeTeam.name, context.awayTeam.name, entry.team?.name, entry.opponent?.name]
    .filter((value): value is string => Boolean(value))
    .map(normalizeForComparison);
  if (
    subject
    && !groundedTeams.includes(subject)
    && !groundedPlayerNames.some((player) => hasGroundedPlayerReference(subject, player))
  ) {
    throw new CommentaryValidationError('Commentary used an ungrounded player as the actor.');
  }
}

function assertGroundedFootballDetails(text: string, entry: MatchPulseCommentaryEntry): void {
  const grounded = normalizeForComparison(JSON.stringify((entry.groundedFacts ?? []).map((fact) => ({
    action: fact.action,
    kind: fact.kind,
    value: fact.value,
  }))));
  const claims: readonly [RegExp, readonly string[], string][] = [
    [/\b(?:from range|long range)\b/i, ['long range', 'from range'], 'shot range'],
    [/\b(?:edge of (?:the )?area|edge of (?:the )?box)\b/i, ['edge of the area', 'edge of area'], 'field location'],
    [/\bdown the middle\b/i, ['down the middle'], 'field location'],
    [/\b(?:off target|wide|over the bar)\b/i, ['off target', 'wide', 'over the bar'], 'shot outcome'],
    [/\b(?:hits?|strikes?) (?:the )?(?:post|bar|woodwork)\b/i, ['post', 'woodwork'], 'woodwork outcome'],
    [/\bdenied\b/i, ['save', 'saved', 'blocked'], 'denied outcome'],
    [/\b(?:top|bottom) corner\b/i, ['top corner', 'bottom corner'], 'goal location'],
  ];
  for (const [pattern, evidence, label] of claims) {
    if (pattern.test(text) && !evidence.some((phrase) => grounded.includes(normalizeForComparison(phrase)))) {
      throw new CommentaryValidationError(`Commentary made an unsupported ${label} claim.`);
    }
  }
}

function assertGroundedContinuity(
  text: string,
  entry: MatchPulseCommentaryEntry,
  previousEntries: readonly MatchPulseCommentaryEntry[],
): void {
  if (!/\b(?:another|again)\b/i.test(text)) return;
  const current = groundedActionCounts(entry);
  const normalized = normalizeForComparison(text);
  const claimedActions = new Set<string>();
  for (const [action, noun] of [
    ['corner', 'corners?'],
    ['shot', '(?:shots?|efforts?|attempts?)'],
    ['free_kick', 'free kicks?'],
  ] as const) {
    if (new RegExp(`\\banother(?:\\s+\\w+){0,3}\\s+${noun}\\b|\\b${noun}\\b(?:\\s+\\w+){0,3}\\s+again\\b`).test(normalized)) {
      claimedActions.add(action);
    }
  }
  const actions = claimedActions.size > 0 ? claimedActions : new Set(current.keys());
  const priorCounts = previousEntries.slice(-4).map(groundedActionCounts);
  const unsupported = [...actions].some((action) =>
    (current.get(action) ?? 0) < 2 && !priorCounts.some((counts) => (counts.get(action) ?? 0) > 0));
  if (unsupported) {
    throw new CommentaryValidationError('Commentary claimed continuity without a grounded earlier action.');
  }
}

function normalizeForComparison(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeCommentary(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error('LLM response did not contain a JSON object.');
}
