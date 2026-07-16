import {
  applyTxlineMatchPulseLlmJson,
  buildTxlineMatchPulseEnrichmentPrompt,
  parseTxlineMatchPulseLlmJson,
  validateTxlineMatchPulseMoment,
  validateTxlineMatchPulseMoments,
  type BeatNarrative,
  type MatchPulseCommentaryEntry,
  type MatchPulseMoment,
  type NarrativeTimeContext,
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
  /** Caught error message for an entry that terminated in enrichmentStatus 'failed'. */
  failureReason?: string;
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
export const COMMENTARY_PROMPT_VERSION = 'engine-commentary-v3-immediate';
export const COMMENTARY_REFLECTION_PROMPT_VERSION = 'engine-commentary-v3-reflection';

/**
 * Deterministic description of how a beat relates to the immediately
 * preceding beat in timeline order. Computed from grounded facts and team
 * identity only — the model never invents continuity, it is told the
 * relation and asked to phrase it naturally.
 */
export type CommentaryRelationToPrevious =
  | 'starts_spell'
  | 'continues_pressure'
  | 'new_attempt'
  | 'possession_flip'
  | 'restart_resets_spell'
  | 'break_in_play'
  | 'major_moment';

export function classifyRelationToPrevious(
  entry: MatchPulseCommentaryEntry,
  previous: MatchPulseCommentaryEntry | undefined,
): CommentaryRelationToPrevious {
  const actions = groundedActionKinds(entry);
  if (actions.has('restart') || actions.has('phase_change') || actions.has('additional_time')) {
    return 'restart_resets_spell';
  }
  if (
    entry.kind === 'goal' || entry.kind === 'penalty' || entry.kind === 'var' || entry.kind === 'card'
    || actions.has('goal') || actions.has('penalty') || actions.has('var')
    || actions.has('red_card') || actions.has('yellow_card')
  ) {
    return 'major_moment';
  }
  if (entry.kind === 'substitution' || entry.kind === 'injury'
    || actions.has('substitution') || actions.has('injury')) {
    return 'break_in_play';
  }
  if (actions.has('possession_change')) return 'possession_flip';
  if (['shot', 'corner', 'free_kick', 'throw_in', 'goal_kick', 'set_piece'].some((action) => actions.has(action))) {
    return 'new_attempt';
  }
  if (!previous) return 'starts_spell';
  const previousResets = classifyPreviousResetsSpell(previous);
  if (previousResets) return 'starts_spell';
  if (entry.team?.id !== undefined && entry.team.id === previous.team?.id) return 'continues_pressure';
  return 'starts_spell';
}

function classifyPreviousResetsSpell(previous: MatchPulseCommentaryEntry): boolean {
  const actions = groundedActionKinds(previous);
  return actions.has('restart') || actions.has('phase_change') || actions.has('additional_time');
}

function groundedActionKinds(entry: MatchPulseCommentaryEntry): Set<string> {
  return new Set([
    ...entry.sourceEvents.map((source) => normalizeAction(source.action)),
    ...(entry.groundedFacts ?? []).flatMap((fact) => [
      normalizeAction(fact.action),
      normalizeCueKind(fact.kind),
    ]),
  ].filter(Boolean));
}

/**
 * Splits pending entries (already in timeline order) into minute batches: a
 * batch never crosses a (period, minute) boundary, and unusually busy minutes
 * are split into near-equal chunks no larger than `cap`.
 */
export function groupEntriesIntoMinuteBatches(
  entries: readonly MatchPulseCommentaryEntry[],
  cap = 16,
): MatchPulseCommentaryEntry[][] {
  const minuteGroups: MatchPulseCommentaryEntry[][] = [];
  let currentKey: string | undefined;
  for (const entry of entries) {
    const key = `${entry.period}:${entry.clock.minute ?? entry.clock.label}`;
    if (key !== currentKey || minuteGroups.length === 0) {
      minuteGroups.push([]);
      currentKey = key;
    }
    minuteGroups.at(-1)!.push(entry);
  }
  const capped = Math.max(1, cap);
  return minuteGroups.flatMap((group) => {
    if (group.length <= capped) return [group];
    const chunkCount = Math.ceil(group.length / capped);
    const chunkSize = Math.ceil(group.length / chunkCount);
    const chunks: MatchPulseCommentaryEntry[][] = [];
    for (let index = 0; index < group.length; index += chunkSize) {
      chunks.push(group.slice(index, index + chunkSize));
    }
    return chunks;
  });
}

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
    // Timeline order for relation/continuity grounding (any status); accepted
    // lines only for the spoken broadcast memory the model continues from.
    const timeline = [...previousEntries];
    const accepted = previousEntries.filter((entry) =>
      entry.enrichmentStatus === 'complete' && entry.commentary.trim().length > 0);
    let failed = 0;

    for (const batch of groupEntriesIntoMinuteBatches(pendingEntries)) {
      const prompt = buildCommentaryMinuteBatchPrompt(context, batch, timeline.at(-1), accepted);
      const completion = await this.createChatCompletionResult(prompt, batchMaxTokens(batch.length));
      let results: MatchPulseCommentaryLlmJson[];
      try {
        results = parseCommentaryBatchLlmJson(completion.content);
      } catch (error) {
        // A response with no readable results array is a provider fault
        // (truncation, malformed output): reject the whole call so the
        // durable worker retries the claim instead of failing every entry.
        throw new CommentaryProviderError(
          error instanceof Error ? error.message : 'Unreadable batch commentary response.',
          { cause: error },
        );
      }
      const resultsById = new Map(results
        .filter((result) => typeof result.entryId === 'string')
        .map((result) => [result.entryId!, result]));

      for (const [index, entry] of batch.entries()) {
        const stages: MatchPulseCommentaryEnrichmentStageTrace[] = [];
        // The single batch request is accounted once, on the batch's first
        // entry, so provider-call and token accounting stay truthful.
        if (index === 0) {
          stages.push({
            stage: 'draft',
            durationMs: completion.durationMs,
            ...(completion.usage ? { usage: completion.usage } : {}),
          });
        }
        let failureReason: string | undefined;
        try {
          const result = resultsById.get(entry.id);
          let draft: MatchPulseCommentaryEntry | undefined;
          let draftFailure: Error | undefined;
          try {
            if (!result) {
              throw new CommentaryValidationError('Batch response did not include a result for this entry.');
            }
            draft = applyCommentaryLlmJson(context, entry, result, timeline);
          } catch (error) {
            draftFailure = error instanceof Error ? error : new Error(String(error));
          }

          let enriched = draft;
          if (shouldReflectCommentary(entry)) {
            const singlePrompt = buildCommentaryEnrichmentPrompt(context, entry, timeline);
            const reflectionPrompt = buildCommentaryReflectionPrompt(
              singlePrompt,
              result ? JSON.stringify(result) : 'The batch response did not include a result for this entry.',
              draftFailure?.message,
              classifyMomentClass(entry.kind, entry.narrative),
            );
            const reflectionCompletion = await this.createChatCompletionResult(reflectionPrompt);
            stages.push(toStageTrace('reflection', reflectionCompletion));
            try {
              enriched = applyCommentaryLlmJson(
                context,
                entry,
                parseCommentaryLlmJson(reflectionCompletion.content),
                timeline,
                COMMENTARY_REFLECTION_PROMPT_VERSION,
              );
            } catch (reflectionError) {
              // Keep a valid batch draft when the reflection pass regresses.
              if (!draft) throw reflectionError;
              enriched = draft;
            }
          } else if (!enriched) {
            throw draftFailure ?? new CommentaryValidationError('Commentary draft could not be validated.');
          }
          enrichedEntries.push(enriched!);
          timeline.push(enriched!);
          accepted.push(enriched!);
        } catch (error) {
          if (error instanceof CommentaryProviderError) throw error;
          failed += 1;
          failureReason = error instanceof Error ? error.message : 'Unknown enrichment error';
          console.warn(JSON.stringify({
            event: 'match_pulse_commentary_enrichment_failed',
            entryId: entry.id,
            reason: failureReason,
          }));
          const failedEntry: MatchPulseCommentaryEntry = {
            ...entry,
            enrichmentStatus: 'failed',
          };
          enrichedEntries.push(failedEntry);
          timeline.push(failedEntry);
        } finally {
          traces.push({ entryId: entry.id, stages, ...(failureReason ? { failureReason } : {}) });
        }
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
    maxTokens = 220,
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
          max_tokens: maxTokens,
          max_completion_tokens: maxTokens,
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

function buildMustCoverFacts(entry: MatchPulseCommentaryEntry) {
  const orderedSources = [...entry.sourceEvents].sort(compareSourceEventsBySeq);
  return entry.groundedFacts?.length
    ? entry.groundedFacts.map((fact) => fact.playerName
      ? { ...fact, playerName: displayPlayerName(fact.playerName) }
      : fact)
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
}

function buildBeatPayload(
  entry: MatchPulseCommentaryEntry,
  previousTimelineEntry: MatchPulseCommentaryEntry | undefined,
) {
  return {
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
      importance: getCommentaryImportance(entry),
      intensity: entry.intensity,
      phase: entry.period,
      clock: entry.clock.label,
      score: entry.scoreAtMoment ? `${entry.scoreAtMoment.home}-${entry.scoreAtMoment.away}` : undefined,
      team: entry.team?.name,
      opponent: entry.opponent?.name,
      development: classifyBeatDevelopment(entry, previousTimelineEntry),
      relationToPrevious: classifyRelationToPrevious(entry, previousTimelineEntry),
      momentClass: classifyMomentClass(entry.kind, entry.narrative),
      mustCoverFacts: buildMustCoverFacts(entry),
      ...(entry.narrative ? { narrative: serializeNarrativeForPrompt(entry.narrative) } : {}),
    },
  };
}

const COMMENTARY_SHARED_SYSTEM_PROMPT: readonly string[] = [
  'You are GameCrew Match Pulse, a football commentator writing one immediate caption per event for a rolling live feed.',
  'Sound like a human commentator speaking to supporters who are following live, not like an event log, notification template, or data analyst.',
  '',
  'SELF-CONTAINMENT — the most important rule:',
  'Each line is displayed on its own and can become the first visible line on screen, with everything before it gone.',
  'Every line must make complete sense read alone: always name the team involved, and never lean on an earlier line through unresolved references.',
  'Never write "that spell", "another one", "it" as the subject of the action, or "they" without naming the team in the same line.',
  'A line may acknowledge the run of play, but only through the teams — "Spain are still working the ball", "France finally win it back". Never name a specific event type (corner, throw-in, free kick, restart, substitution, goal, card) unless that event is in the line\'s own mustCoverFacts, with one exception: a line may look back at an event from the shown previous lines using "after", "following", or "since" ("after the substitution, France settle again", "since the goal, Spain have controlled it") — never at a penalty or a VAR decision.',
  'Use "another" or "again" with an event noun only when your own entry\'s facts repeat that action; otherwise phrase continuation through the team instead.',
  '',
  'SEQUENCE AND CONTINUITY:',
  'Entries are in true match order. Treat previously accepted lines as words you have already spoken during the same broadcast.',
  'Each line answers: what is happening now? Use relationToPrevious to shape how the line connects while staying self-contained:',
  'starts_spell: the named team begins a fresh period on the ball — a clean, fresh opening.',
  'continues_pressure: the same team remains on top — vary the phrasing, acknowledge the continuing spell, and still name the team.',
  'possession_flip: the ball changes hands — make the handover from one named team to the other clear.',
  'new_attempt: a discrete event (set piece, shot, corner, free kick, throw-in) inside the current flow — report it plainly.',
  'restart_resets_spell: play restarts (kickoff, second half, after a goal) — the previous rhythm is over; open cleanly.',
  'break_in_play: a pause such as a substitution or injury — a calm interruption note.',
  'major_moment: the biggest register — follow the momentClass instruction.',
  'A line may only reference events that came earlier. Never mention, hint at, or set up any event that appears later, even when you can see it in the same request.',
  'The interface already shows the minute. Omit it from routine commentary unless timing itself makes the moment significant.',
  'Do not keep repeating the score, competition, matchup, or both full team names when listeners already have that context.',
  '',
  'VOICE:',
  'Use natural spoken football English with varied sentence openings and rhythm. Consecutive lines must not open the same way.',
  'Match the importance: routine needs one concise sentence; developing may use one or two connected sentences; major may breathe for two or three short sentences.',
  'Do not manufacture drama; never invent facts to justify excitement.',
  'Avoid event-log phrasing, stat-list phrasing, and stock lines such as looking to, setting the tempo, building pressure, knocking on the door, early doors, warning signs, or asking questions.',
  'For kickoff, prefer one direct line such as "And we are underway" or "[Team] get us underway". Do not say kickoff and the game begins in the same line.',
  '',
  'STYLE EXAMPLES — copy the movement, never the facts or bracketed placeholders:',
  '"[Team] get us underway."',
  '"[Team] work the ball forward again, still dictating this stretch of play."',
  '"A corner now for [Team], won at the end of a patient move."',
  '"[Opponent] finally take the ball back off [Team]."',
  '"Free kick to [Team], a moment to reset after [Opponent] had settled on the ball."',
  '',
  'GROUNDING:',
  'Each entry and its mustCoverFacts are the only authority for what happened in that entry. Earlier lines are continuity context, not evidence for a new current fact.',
  'Cover every mustCoverFact in its supplied seq order. coveredFrameIds is an auditable claim of which supplied facts the line covers, not permission to add facts.',
  'Sparse event data is not full play-by-play. Do not invent causal links, player names, formations, injuries, exact locations, possession, chance quality, or event outcomes.',
  'Do not invent crowd, stadium, celebration, referee-action, score-state, or atmosphere details. Do not describe what can be heard or say that the place lifts or erupts. Mention a lead or score only when the entry score supplies it.',
  'Do not mention the box, goalkeeper, save, miss, block, clearance, delivery, cross, header, goal, card, penalty, VAR, or score change unless that fact is explicitly supplied for the current entry.',
  'In particular, when current events contain only shots, corners, free kicks, or throw-ins, do not use goal, goalward, goalmouth, net, scorer, opener, breakthrough, or scoring language.',
  'Do not name pitch zones or locations — location data is never supplied. Forbidden location words include: third, thirds, flank, wing, byline, box, area, post, centre circle, own half, opposition half, "high up the pitch". Say "push forward", "move into a dangerous position", or "drop deeper" instead.',
  'Never expose confidence, verification, source, validation, action-label, or schema terminology to the supporter.',
];

export function buildCommentaryEnrichmentPrompt(
  context: MatchPulseCommentaryGroundingContext,
  entry: MatchPulseCommentaryEntry,
  previousEntries: readonly MatchPulseCommentaryEntry[],
): readonly { role: 'system' | 'user'; content: string }[] {
  const recentSpoken = previousEntries
    .filter((previous) => previous.commentary.trim().length > 0)
    .slice(-4);
  const momentClass = classifyMomentClass(entry.kind, entry.narrative);
  const modelInput = {
    match: {
      home: context.homeTeam.name,
      away: context.awayTeam.name,
    },
    ...buildBeatPayload(entry, previousEntries.at(-1)),
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
        ...COMMENTARY_SHARED_SYSTEM_PROMPT,
        getMomentClassRegisterInstruction(momentClass),
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

export function buildCommentaryMinuteBatchPrompt(
  context: MatchPulseCommentaryGroundingContext,
  batch: readonly MatchPulseCommentaryEntry[],
  previousTimelineEntry: MatchPulseCommentaryEntry | undefined,
  previousAcceptedEntries: readonly MatchPulseCommentaryEntry[],
): readonly { role: 'system' | 'user'; content: string }[] {
  const firstEntry = batch[0]!;
  const previousAccepted = previousAcceptedEntries
    .filter((previous) => previous.commentary.trim().length > 0)
    .slice(-3);
  const modelInput = {
    match: {
      home: context.homeTeam.name,
      away: context.awayTeam.name,
    },
    batch: {
      minute: firstEntry.clock.label,
      period: firstEntry.period,
      promptVersion: COMMENTARY_PROMPT_VERSION,
      entryCount: batch.length,
    },
    previousAcceptedLines: previousAccepted.map((previous) => ({
      clock: previous.clock.label,
      team: previous.team?.name,
      commentary: previous.commentary,
    })),
    entries: batch.map((entry, index) => ({
      order: index + 1,
      ...buildBeatPayload(entry, index === 0 ? previousTimelineEntry : batch[index - 1]),
    })),
  };

  return [
    {
      role: 'system',
      content: [
        ...COMMENTARY_SHARED_SYSTEM_PROMPT,
        '',
        'BATCH CONTRACT:',
        'The request supplies every entry for one match minute, in true order.',
        'Return exactly one result for every entry, in the same order — never a combined summary, never a skipped entry, never an extra result.',
        'Write each line so that the batch reads as consecutive moments of one broadcast, while every individual line still stands alone.',
        'Each result covers only its own entry and its own mustCoverFacts. Never let a neighbouring entry\'s event leak into a line: the restart, throw-in, corner, substitution, or goal that appears elsewhere in this batch is narrated only by its own entry, and no other line may mention it, foreshadow it, or react to it by name.',
        '',
        'OUTPUT:',
        'Return only valid JSON.',
        'Use exactly this shape: {"results":[{"entryId":"echo the entry contract.entryId","commentary":"...","voiceLine":"optional shorter spoken alternative","coveredFrameIds":["every requiredCoveredFrameId of that entry"]}]}.',
        'The results array must contain one object per supplied entry, in the supplied order.',
        'Follow each entry momentClass register: standard stays calm and measured; notable carries weight without shouting; elevated is high energy; maximum is the biggest register with real excitement.',
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
  momentClass: MomentClass = 'standard',
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
          `Confirm the register matches the supplied momentClass ("${momentClass}"): ${getMomentClassRegisterInstruction(momentClass)}`,
        ],
        instruction: 'Critique the draft silently, then return only one improved final JSON object. Echo the original contract metadata and requiredCoveredFrameIds exactly.',
      }),
    },
  ];
}

/**
 * Only major beats (goals, cards, VAR, phase changes) earn a second polishing
 * request. Routine and developing beats are written once inside their minute
 * batch — the batch itself is the continuity mechanism.
 */
function shouldReflectCommentary(entry: MatchPulseCommentaryEntry): boolean {
  return getCommentaryImportance(entry) === 'major';
}

/** Completion budget for a minute batch: enough for every line plus JSON overhead. */
function batchMaxTokens(entryCount: number): number {
  return Math.min(4_000, 300 + 130 * entryCount);
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

/**
 * Deterministic tone register for a beat, ordered least to most intense.
 * The model never picks its own register: `classifyMomentClass` computes it
 * from beat kind plus narrative memory, and the system/reflection prompts
 * select a fixed instruction for the resulting class.
 */
export type MomentClass = 'standard' | 'notable' | 'elevated' | 'maximum';

const LATE_TIME_CONTEXTS: ReadonlySet<NarrativeTimeContext> = new Set(['closing_stages', 'stoppage']);

/**
 * Classifies the tone register for a beat from its kind plus its
 * (relevance-gated) narrative memory. Pure and deterministic: the same
 * `(kind, narrative)` pair always yields the same class.
 *
 * - `maximum`: a goal whose scoreStory includes `comeback` or `late_winner`.
 * - `elevated`: any other goal; a second-yellow red card; any red card.
 * - `notable`: pressure toward an equaliser with a sustained spell
 *   (`momentum.pressureSpellBeats >= 3`); a card once the carded team has
 *   `discipline.teamYellowCount >= 4`; a substitution in the closing stages
 *   or stoppage time.
 * - `standard`: everything else (the default, calm register).
 */
export function classifyMomentClass(
  kind: MatchPulseCommentaryEntry['kind'],
  narrative: BeatNarrative | undefined,
): MomentClass {
  if (kind === 'goal') {
    const events = narrative?.scoreStory?.events ?? [];
    if (events.includes('comeback') || events.includes('late_winner')) return 'maximum';
    return 'elevated';
  }
  if (kind === 'card') {
    if (narrative?.discipline?.secondYellowRed) return 'elevated';
    if (narrative?.discipline?.menRemainingReduced) return 'elevated';
    if ((narrative?.discipline?.teamYellowCount ?? 0) >= 4) return 'notable';
    return 'standard';
  }
  if (narrative?.momentum && narrative.momentum.pressureSpellBeats >= 3) return 'notable';
  if (kind === 'substitution' && narrative?.timeContext && LATE_TIME_CONTEXTS.has(narrative.timeContext)) {
    return 'notable';
  }
  return 'standard';
}

const MOMENT_CLASS_REGISTER: Record<MomentClass, string> = {
  standard: 'Be lively when the facts deserve it, but keep the calm, measured register of routine commentary.',
  notable: 'This moment carries weight — let the line acknowledge it without shouting.',
  elevated: 'This is a major moment. Higher energy, short punchy sentences, an exclamation is appropriate.',
  maximum: 'This is one of the biggest moments a match can produce. Let it breathe with real excitement — two or three short, high-energy sentences. An exclamation is expected.',
};

function getMomentClassRegisterInstruction(momentClass: MomentClass): string {
  return MOMENT_CLASS_REGISTER[momentClass];
}

/**
 * Compacts a beat's narrative memory for the prompt: only present slices ride
 * along, and each slice's `derivedFrom` audit trail is dropped since it is
 * for validator/debugging use only and would otherwise waste prompt tokens.
 */
function serializeNarrativeForPrompt(narrative: BeatNarrative): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  if (narrative.scoreStory) {
    const { derivedFrom: _derivedFrom, ...rest } = narrative.scoreStory;
    compact.scoreStory = rest;
  }
  if (narrative.discipline) {
    const { derivedFrom: _derivedFrom, ...rest } = narrative.discipline;
    compact.discipline = rest;
  }
  if (narrative.playerMemory) {
    const { derivedFrom: _derivedFrom, ...rest } = narrative.playerMemory;
    compact.playerMemory = rest;
  }
  if (narrative.momentum) {
    const { derivedFrom: _derivedFrom, ...rest } = narrative.momentum;
    compact.momentum = rest;
  }
  if (narrative.timeContext) {
    compact.timeContext = narrative.timeContext;
  }
  return compact;
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

  return toCommentaryLlmJson(candidate, candidate.commentary);
}

/**
 * Parses a minute-batch response into one candidate per returned entry.
 * Individually malformed items survive as empty-commentary candidates so a
 * single bad row fails only its own entry during validation — but a response
 * with no readable results array at all throws, which the caller treats as a
 * retryable provider fault.
 */
export function parseCommentaryBatchLlmJson(content: string): MatchPulseCommentaryLlmJson[] {
  const parsed = JSON.parse(extractJsonValue(content)) as unknown;
  const items = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown }).results))
      ? (parsed as { results: unknown[] }).results
      : undefined;
  if (!items) {
    throw new Error('Batch commentary response did not include a results array.');
  }
  return items
    .filter((item): item is Partial<MatchPulseCommentaryLlmJson> => Boolean(item) && typeof item === 'object')
    .map((item) => toCommentaryLlmJson(
      item,
      typeof item.commentary === 'string' ? item.commentary : '',
    ));
}

function toCommentaryLlmJson(
  candidate: Partial<MatchPulseCommentaryLlmJson>,
  commentary: string,
): MatchPulseCommentaryLlmJson {
  return {
    entryId: typeof candidate.entryId === 'string' ? candidate.entryId : undefined,
    batchId: typeof candidate.batchId === 'string' ? candidate.batchId : undefined,
    projectionGeneration: typeof candidate.projectionGeneration === 'number'
      ? candidate.projectionGeneration
      : undefined,
    commentary,
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

  // entryId is the matching key and must always echo correctly; batchId and
  // projectionGeneration are redundant echoes that only need to be consistent
  // when the model chooses to repeat them.
  if (llmJson.entryId !== entry.id || (llmJson.batchId !== undefined && llmJson.batchId !== entry.batchId)) {
    throw new CommentaryValidationError('Commentary contract metadata does not match the current entry generation.');
  }
  if (
    entry.projectionGeneration !== undefined
    && llmJson.projectionGeneration !== undefined
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

  // Every line can become the first visible line of the overlay, so it must
  // never lean on a previous line through an unresolved reference.
  if (/\bthat spell\b|\banother one\b/i.test(combined)) {
    throw new CommentaryValidationError('Commentary must be self-contained: avoid unresolved references like "that spell" or "another one".');
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
    entry.kind === 'goal'
      || sourceActions.has('goal')
      || getRestartContext(entry) === 'after_goal'
      || isAllowedBackwardActionReference(combined, 'goal', /\bgoal(?:s|ed|ing)?(?![ -]?kick)\b/gi, previousEntries),
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
  assertGroundedNarrativeClaims(combined, entry);
  if (/\b(?:crowd|fans?|stadium|supporters?|hear the place|place (?:lifts?|erupts?))\b/i.test(combined)) {
    throw new CommentaryValidationError('Commentary cannot invent crowd or stadium atmosphere.');
  }
  if (/\b(?:puts?|raises?) (?:the )?whistle\b|\bwhistle to (?:his|her|their) lips\b|\b(?:the )?referee blows?\b/i.test(combined)) {
    throw new CommentaryValidationError('Commentary cannot invent a physical referee action.');
  }
  assertNoFutureSpeculation(combined, entry);

  assertClosedWorldMaterialActions(combined, sourceActions, entry, previousEntries);
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

/**
 * Actions a line may look back at ("after the substitution, France settle",
 * "since the goal, Spain have kept the ball") when the action is grounded in
 * the recent timeline AND every mention sits in an explicit backward
 * construction (after/following/since) — so it can never read as a new
 * current event. Penalty and VAR stay excluded: their lifecycle is too
 * sensitive to reference loosely.
 */
const BACKWARD_REFERENCEABLE_ACTIONS: ReadonlySet<string> = new Set([
  'restart', 'substitution', 'injury', 'corner', 'free_kick', 'throw_in',
  'goal_kick', 'shot', 'additional_time', 'offside', 'goal',
  'yellow_card', 'red_card',
]);

function recentGroundedActions(
  previousEntries: readonly MatchPulseCommentaryEntry[],
): Set<string> {
  return new Set(previousEntries.slice(-4).flatMap((previous) =>
    (previous.groundedFacts ?? [])
      .filter((fact) => normalizeCueKind(fact.kind) !== 'incident_retracted')
      .flatMap((fact) => [normalizeAction(fact.action), normalizeCueKind(fact.kind)])
      .filter(Boolean)));
}

/**
 * True when `action` is backward-referenceable, grounded in the recent
 * timeline, and every occurrence of `pattern` in `text` is an explicit
 * backward construction.
 */
function isAllowedBackwardActionReference(
  text: string,
  action: string,
  pattern: RegExp,
  previousEntries: readonly MatchPulseCommentaryEntry[],
): boolean {
  return BACKWARD_REFERENCEABLE_ACTIONS.has(action)
    && recentGroundedActions(previousEntries).has(action)
    && isBackwardReferenceOnly(text, pattern);
}

function assertClosedWorldMaterialActions(
  text: string,
  sourceActions: ReadonlySet<string>,
  entry: MatchPulseCommentaryEntry,
  previousEntries: readonly MatchPulseCommentaryEntry[] = [],
): void {
  const previousActions = recentGroundedActions(previousEntries);
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
      const groundedEarlier = claim.actions.some((action) =>
        BACKWARD_REFERENCEABLE_ACTIONS.has(action) && previousActions.has(action));
      if (!groundedEarlier || !isBackwardReferenceOnly(claimText, claim.pattern)) {
        throw new CommentaryValidationError(`Commentary made unsupported ${claim.label} claim.`);
      }
    }
  }
}

/**
 * True when every occurrence of `pattern` in `text` sits inside an explicitly
 * backward-looking construction ("after the restart", "following that France
 * substitution") within the same sentence.
 */
function isBackwardReferenceOnly(text: string, pattern: RegExp): boolean {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    const preceding = text.slice(Math.max(0, (match.index ?? 0) - 48), match.index);
    if (!/\b(?:after|following|since)\b[^.!?]*$/i.test(preceding)) return false;
  }
  return true;
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
  if (goal?.playerName) {
    const otherPlayerNames = facts
      .filter((fact) => fact !== goal)
      .map((fact) => fact.playerName)
      .filter((value): value is string => Boolean(value));
    if (!hasGroundedPlayerReference(text, goal.playerName, otherPlayerNames)) {
      throw new CommentaryValidationError('Commentary omitted or changed the grounded scorer name.');
    }
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

/**
 * Parses a supplied player name into normalized, deduped tokens, tracking
 * which tokens came from the surname group. Source names commonly arrive in
 * reversed CRM-style form ("Surname [Surname2], Firstname [Firstname2]"),
 * including an exactly-repeated adjacent surname ("Quinones Quinones,
 * Julian Andres"). Names without a comma have no distinguished surname
 * group, since we cannot tell which token is the surname.
 */
function parseGroundedPlayerName(playerName: string): { tokens: string[]; surnameTokens: Set<string> } {
  const commaIndex = playerName.indexOf(',');
  const surnamePart = commaIndex === -1 ? undefined : playerName.slice(0, commaIndex);
  const dedupedWhole = normalizeForComparison(displayPlayerName(playerName));
  const tokens = [...new Set(dedupedWhole.split(' ').filter((token) => token.length > 1))];
  const surnameTokens = new Set(
    surnamePart === undefined
      ? []
      : normalizeForComparison(dedupeAdjacentTokens(surnamePart)).split(' ').filter((token) => token.length > 1),
  );
  return { tokens, surnameTokens };
}

/**
 * True when `text` grounds `playerName` for the current entry. Requires
 * either (a) at least two of the player's canonical tokens appear in the
 * text, or (b) exactly one matched token is a canonical surname token that
 * is not shared by any other grounded player supplied via `otherPlayerNames`
 * (ambiguity guard — when two grounded players share a surname, a lone
 * surname mention cannot be resolved and must still fail).
 */
function hasGroundedPlayerReference(
  text: string,
  playerName: string,
  otherPlayerNames: readonly string[] = [],
): boolean {
  const { tokens: supplied, surnameTokens } = parseGroundedPlayerName(playerName);
  const spoken = new Set(normalizeForComparison(text).split(' '));
  const matched = supplied.filter((token) => spoken.has(token));
  if (matched.length >= 2) return true;
  if (matched.length !== 1) return false;

  const [onlyMatch] = matched;
  if (!surnameTokens.has(onlyMatch!)) return false;

  const sharedByOtherPlayer = otherPlayerNames.some((other) => {
    if (normalizeForComparison(other) === normalizeForComparison(playerName)) return false;
    return parseGroundedPlayerName(other).surnameTokens.has(onlyMatch!)
      || parseGroundedPlayerName(other).tokens.includes(onlyMatch!);
  });
  return !sharedByOtherPlayer;
}

/**
 * Adjective forms of national team names. A line like "the French pressure
 * continues" grounds "French" in the team name France — it is attribution,
 * not an invented person. Extend as new fixtures need it; unknown team names
 * simply get no adjective allowance (fail-closed, as before).
 */
const TEAM_NAME_DEMONYMS: Readonly<Record<string, readonly string[]>> = {
  argentina: ['argentine', 'argentinian'],
  belgium: ['belgian'],
  brazil: ['brazilian'],
  croatia: ['croatian'],
  ecuador: ['ecuadorian', 'ecuadorean'],
  england: ['english'],
  france: ['french'],
  germany: ['german'],
  italy: ['italian'],
  japan: ['japanese'],
  mexico: ['mexican'],
  morocco: ['moroccan'],
  netherlands: ['dutch'],
  portugal: ['portuguese'],
  spain: ['spanish'],
  uruguay: ['uruguayan'],
};

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
    for (const token of String(value ?? '').match(/\p{L}+/gu) ?? []) {
      const normalized = normalizeForComparison(token);
      allowed.add(normalized);
      for (const demonym of TEAM_NAME_DEMONYMS[normalized] ?? []) allowed.add(demonym);
    }
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
    && !groundedPlayerNames.some((player, index) => hasGroundedPlayerReference(
      subject,
      player,
      groundedPlayerNames.filter((_, otherIndex) => otherIndex !== index),
    ))
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

const ORDINAL_WORDS: readonly string[] = [
  'zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
];

/** Matches an ordinal (numeral or word) immediately before `noun`, e.g. "fourth yellow" or "4th yellow". */
function ordinalClaimPattern(noun: string): RegExp {
  return new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${noun}\\b|\\b(${ORDINAL_WORDS.join('|')})\\s+${noun}\\b`, 'i');
}

function ordinalValue(match: RegExpMatchArray): number | undefined {
  if (match[1]) return Number(match[1]);
  if (match[2]) {
    const index = ORDINAL_WORDS.indexOf(match[2].toLowerCase());
    return index === -1 ? undefined : index;
  }
  return undefined;
}

/**
 * Validates memory-derived claim vocabulary (discipline counts, player goal
 * tallies, and score-story language) against `entry.narrative`. A claim word
 * with no supporting narrative fact still fails closed, exactly like any
 * other unsupported claim - this only widens what counts as "grounded", it
 * never loosens the closed-world default.
 */
function assertGroundedNarrativeClaims(text: string, entry: MatchPulseCommentaryEntry): void {
  const narrative = entry.narrative;

  // "Second yellow" is football idiom for a player's own second booking
  // (which produces a red card), never a team's cumulative yellow tally - so
  // it is checked against `secondYellowRed`, not the team-ordinal count
  // below. Team-ordinal card claims ("fourth yellow", "third booking") start
  // from "third" to avoid colliding with that idiom.
  if (/\bsecond yellow\b/i.test(text)) {
    if (!narrative?.discipline?.secondYellowRed) {
      throw new CommentaryValidationError('Commentary made an unsupported second-yellow claim.');
    }
  }

  const yellowMatch = text.match(ordinalClaimPattern('yellow(?:s|\\s+cards?)?'));
  const bookingMatch = text.match(ordinalClaimPattern('bookings?'));
  const ordinalCardMatch = yellowMatch ?? bookingMatch;
  if (ordinalCardMatch) {
    const claimed = ordinalValue(ordinalCardMatch);
    if (claimed === 2) {
      // Already validated above as the second-yellow-red idiom.
    } else {
      const teamYellowCount = narrative?.discipline?.teamYellowCount;
      if (claimed === undefined || teamYellowCount === undefined || claimed !== teamYellowCount) {
        throw new CommentaryValidationError('Commentary made an unsupported card-count claim.');
      }
    }
  }

  if (/\bdown to ten\b|\bdown to 10\b|\bten men\b|\b10 men\b/i.test(text)) {
    if (!narrative?.discipline?.menRemainingReduced) {
      throw new CommentaryValidationError('Commentary made an unsupported men-remaining claim.');
    }
  }

  if (/\bbrace\b|\bhis second\b|\bher second\b|\btheir second\b/i.test(text)) {
    if (narrative?.playerMemory?.scorerGoalsThisMatch !== 2) {
      throw new CommentaryValidationError('Commentary made an unsupported brace claim.');
    }
  }
  if (/\bhat[ -]?trick\b|\bhis third\b|\bher third\b|\btheir third\b/i.test(text)) {
    if (narrative?.playerMemory?.scorerGoalsThisMatch !== 3) {
      throw new CommentaryValidationError('Commentary made an unsupported hat-trick claim.');
    }
  }

  if (/\bcomeback\b|\bturned it around\b|\bturn it around\b/i.test(text)) {
    if (!narrative?.scoreStory?.events.includes('comeback')) {
      throw new CommentaryValidationError('Commentary made an unsupported comeback claim.');
    }
  }
  if (/\bequalis(?:e|es|ed|ing)|\bequaliz(?:e|es|ed|ing)|\blevels?\b/i.test(text)) {
    if (!narrative?.scoreStory?.events.includes('equaliser')) {
      throw new CommentaryValidationError('Commentary made an unsupported equaliser claim.');
    }
  }
  if (/\blate winner\b/i.test(text)) {
    if (!narrative?.scoreStory?.events.includes('late_winner')) {
      throw new CommentaryValidationError('Commentary made an unsupported late-winner claim.');
    }
  }
  if (/\bin stoppage time\b|\bstoppage[ -]time\b/i.test(text)) {
    const isLateWinner = narrative?.scoreStory?.events.includes('late_winner');
    const isStoppageTimeContext = narrative?.timeContext === 'stoppage';
    // "Additional time" fact coverage already grounds stoppage time from the
    // clock directly (isClockGroundedStoppageTime); narrative is one more way
    // to ground the same claim, not the only way.
    if (!isLateWinner && !isStoppageTimeContext && !isClockGroundedStoppageTime(entry)) {
      throw new CommentaryValidationError('Commentary made an unsupported stoppage-time claim.');
    }
  }
}

function normalizeForComparison(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Source player names arrive in reversed CRM-style form, e.g.
 * "Quinones Quinones, Julian Andres" (note the duplicated surname) or
 * "Mbappe Lottin, Kylian". Reorder to natural "Firstname Surname" display
 * form and dedupe an exactly-repeated adjacent surname token. Names without
 * a comma, or with a single token, pass through unchanged.
 *
 * NOTE: this is duplicated in packages/core/src/match-engine/commentary.ts
 * (fallbackFor) because that file cannot share an export with this one
 * without touching reserved index/export wiring. Keep both in sync.
 */
export function displayPlayerName(rawName: string): string {
  const trimmed = rawName.trim();
  const commaIndex = trimmed.indexOf(',');
  if (commaIndex === -1) return dedupeAdjacentTokens(trimmed);

  const surnamePart = trimmed.slice(0, commaIndex).trim();
  const givenPart = trimmed.slice(commaIndex + 1).trim();
  if (!surnamePart || !givenPart) return dedupeAdjacentTokens(trimmed.replace(/,/g, ' ').replace(/\s+/g, ' ').trim());

  const surname = dedupeAdjacentTokens(surnamePart);
  return `${givenPart} ${surname}`.replace(/\s+/g, ' ').trim();
}

function dedupeAdjacentTokens(value: string): string {
  const tokens = value.split(/\s+/).filter(Boolean);
  const deduped: string[] = [];
  for (const token of tokens) {
    if (deduped.length > 0 && deduped[deduped.length - 1]!.toLowerCase() === token.toLowerCase()) continue;
    deduped.push(token);
  }
  return deduped.join(' ');
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

/** Like extractJsonObject but also accepts a bare top-level JSON array. */
function extractJsonValue(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed;
  const start = trimmed.indexOf('[');
  const objectStart = trimmed.indexOf('{');
  if (start !== -1 && (objectStart === -1 || start < objectStart)) {
    const end = trimmed.lastIndexOf(']');
    if (end > start) return trimmed.slice(start, end + 1);
  }
  return extractJsonObject(content);
}
